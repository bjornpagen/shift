import * as ts from "typescript"
import { tryCatch } from "../utils/try-catch"

interface KuzuConnection {
  query: (queryString: string) => Promise<{ getAll: () => Promise<unknown[]> }>
}

function getLocation(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = node.getStart()
  const end = node.getEnd()
  const { line: startLine, character: startColumn } =
    sourceFile.getLineAndCharacterOfPosition(start)
  const { line: endLine, character: endColumn } =
    sourceFile.getLineAndCharacterOfPosition(end)
  console.debug(
    `Node location: start ${startLine + 1}:${startColumn + 1}, end ${endLine + 1}:${endColumn + 1}`
  )
  return {
    startLine: startLine + 1,
    startColumn: startColumn + 1,
    endLine: endLine + 1,
    endColumn: endColumn + 1
  }
}

function escapeCypherString(str: string): string {
  return str
    .replace(/\n/g, " ")
    .replace(/'/g, "''")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .trim()
}

function isFunctionLikeDeclaration(
  node: ts.Node
): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  )
}

function getFunctionName(node: ts.FunctionLikeDeclaration): string {
  if (ts.isFunctionDeclaration(node)) {
    return node.name?.text || "anonymous"
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  ) {
    return node.name.getText()
  }
  if (ts.isConstructorDeclaration(node)) {
    return "constructor"
  }
  if (ts.isFunctionExpression(node)) {
    return node.name?.text || "anonymous"
  }
  if (ts.isArrowFunction(node)) {
    return "anonymous"
  }
  return "unknown"
}

export async function parseAndUpdateKuzu(
  conn: KuzuConnection,
  sourceFile: ts.SourceFile,
  program: ts.Program,
  typeChecker: ts.TypeChecker
) {
  const filePath = sourceFile.fileName
  console.debug(`Parsing file: ${filePath}`)

  const functionStack: string[] = []

  async function createOrGetFunctionNode(
    targetNode: ts.Node,
    declSourceFile: ts.SourceFile
  ) {
    const calleeId = `${declSourceFile.fileName}:${targetNode.pos}`
    const safeCalleeId = escapeCypherString(calleeId)

    if (isFunctionLikeDeclaration(targetNode)) {
      const location = getLocation(declSourceFile, targetNode)
      const funcName = getFunctionName(targetNode)
      const safeFuncName = escapeCypherString(funcName)
      const safeDeclFilePath = escapeCypherString(declSourceFile.fileName)

      // Ensure the callee Function node exists
      const mergeResult = await tryCatch(
        conn.query(
          `MERGE (func:Function {
            id: '${safeCalleeId}',
            name: '${safeFuncName}',
            startLine: ${location.startLine},
            startColumn: ${location.startColumn},
            endLine: ${location.endLine},
            endColumn: ${location.endColumn}
          })`
        )
      )

      if (mergeResult.error) {
        console.error(`Error creating function node: ${mergeResult.error}`)
        return null
      }

      // Link the callee to its file
      const linkResult = await tryCatch(
        conn.query(
          `MATCH (f:File {path: '${safeDeclFilePath}'}), (func:Function {id: '${safeCalleeId}'})
           MERGE (f)-[:HasFunction]->(func)`
        )
      )

      if (linkResult.error) {
        console.error(`Error linking function to file: ${linkResult.error}`)
        return null
      }

      return safeCalleeId
    }

    return null
  }

  async function resolveSymbolToNode(
    symbol: ts.Symbol
  ): Promise<ts.Node | null> {
    if (!symbol) {
      return null
    }

    const declarations = symbol.getDeclarations()
    if (!declarations || declarations.length === 0) {
      return null
    }

    const decl = declarations[0]

    // Handle direct function declarations
    if (isFunctionLikeDeclaration(decl)) {
      return decl
    }

    // Handle variable declarations with function initializers
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      if (isFunctionLikeDeclaration(decl.initializer)) {
        return decl.initializer
      }

      // Handle cases where the variable is initialized with an imported symbol
      if (ts.isIdentifier(decl.initializer)) {
        const initializerSymbol = typeChecker.getSymbolAtLocation(
          decl.initializer
        )
        if (initializerSymbol && initializerSymbol !== symbol) {
          return resolveSymbolToNode(initializerSymbol)
        }
      }
    }

    // Handle import declarations
    if (ts.isImportSpecifier(decl)) {
      const importSymbol = typeChecker.getSymbolAtLocation(decl.name)
      if (importSymbol && importSymbol !== symbol) {
        // Try to resolve the imported symbol to its actual declaration
        const exportedSymbol = typeChecker.getAliasedSymbol(symbol)
        if (exportedSymbol && exportedSymbol !== symbol) {
          return resolveSymbolToNode(exportedSymbol)
        }
      }
    }

    // Handle export declarations
    if (ts.isExportSpecifier(decl)) {
      const exportedSymbol = typeChecker.getAliasedSymbol(symbol)
      if (exportedSymbol && exportedSymbol !== symbol) {
        return resolveSymbolToNode(exportedSymbol)
      }
    }

    return null
  }

  async function visitNode(node: ts.Node) {
    if (ts.isFunctionLike(node) && isFunctionLikeDeclaration(node)) {
      const location = getLocation(sourceFile, node)
      const funcId = `${filePath}:${node.pos}`
      const funcName = getFunctionName(node)
      const safeFuncId = escapeCypherString(funcId)
      const safeFuncName = escapeCypherString(funcName)
      const safeFilePath = escapeCypherString(filePath)

      // Create Function node
      const createFuncResult = await tryCatch(
        conn.query(
          `MERGE (func:Function {
            id: '${safeFuncId}',
            name: '${safeFuncName}',
            startLine: ${location.startLine},
            startColumn: ${location.startColumn},
            endLine: ${location.endLine},
            endColumn: ${location.endColumn}
          })`
        )
      )

      if (createFuncResult.error) {
        console.error(`Error creating function node: ${createFuncResult.error}`)
        return
      }

      // Link Function to File
      const linkFuncResult = await tryCatch(
        conn.query(
          `MATCH (f:File {path: '${safeFilePath}'}), (func:Function {id: '${safeFuncId}'})
           MERGE (f)-[:HasFunction]->(func)`
        )
      )

      if (linkFuncResult.error) {
        console.error(`Error linking function to file: ${linkFuncResult.error}`)
        return
      }

      functionStack.push(funcId)
      for (const child of node.getChildren()) {
        await visitNode(child)
      }
      functionStack.pop()
    } else if (ts.isCallExpression(node) && functionStack.length > 0) {
      const callerId = functionStack[functionStack.length - 1]
      const safeCallerId = escapeCypherString(callerId)

      // Get the symbol for the called function
      let callExprSymbol: ts.Symbol | undefined

      if (ts.isPropertyAccessExpression(node.expression)) {
        // For method calls like obj.method()
        callExprSymbol = typeChecker.getSymbolAtLocation(node.expression.name)

        // If we can't resolve the method directly, try to get it from the object's type
        if (!callExprSymbol) {
          const objType = typeChecker.getTypeAtLocation(
            node.expression.expression
          )
          const property = node.expression.name.text
          const methodSymbol = typeChecker.getPropertyOfType(objType, property)
          if (methodSymbol) {
            callExprSymbol = methodSymbol
          }
        }
      } else {
        // For direct function calls like func()
        callExprSymbol = typeChecker.getSymbolAtLocation(node.expression)
      }

      if (callExprSymbol) {
        // Try to resolve the symbol to a node
        const targetNode = await resolveSymbolToNode(callExprSymbol)

        if (targetNode) {
          const declSourceFile = targetNode.getSourceFile()

          // Skip declaration files (e.g., lib.d.ts)
          if (declSourceFile && !declSourceFile.isDeclarationFile) {
            // Create or get the function node in the database
            const safeCalleeId = await createOrGetFunctionNode(
              targetNode,
              declSourceFile
            )

            if (safeCalleeId) {
              // Create the Calls relationship
              const createCallsResult = await tryCatch(
                conn.query(
                  `MATCH (caller:Function {id: '${safeCallerId}'}), (callee:Function {id: '${safeCalleeId}'})
                   MERGE (caller)-[:Calls]->(callee)`
                )
              )

              if (createCallsResult.error) {
                console.error(
                  `Error creating Calls relationship: ${createCallsResult.error}`
                )
              }

              // For cross-file calls, log it
              if (declSourceFile.fileName !== sourceFile.fileName) {
                console.debug(
                  `Cross-file call: ${sourceFile.fileName} -> ${declSourceFile.fileName}`
                )
              }
            }
          }
        } else {
          // If we couldn't resolve to a specific node, try using the symbol's name
          const symName = callExprSymbol.getName()
          if (
            symName &&
            symName !== "undefined" &&
            symName !== "__promisify__"
          ) {
            // Use program to search all source files for matching function
            for (const sf of program.getSourceFiles()) {
              // Skip declaration files
              if (sf.isDeclarationFile) {
                continue
              }

              // Skip the current file as we've already checked it
              if (sf.fileName === sourceFile.fileName) {
                continue
              }

              // Check if this file might contain our target function
              const functionNodes = findFunctionsWithNameInFile(sf, symName)
              for (const funcNode of functionNodes) {
                // Create the node and relationship
                const safeCalleeId = await createOrGetFunctionNode(funcNode, sf)
                if (safeCalleeId) {
                  const createCallsResult = await tryCatch(
                    conn.query(
                      `MATCH (caller:Function {id: '${safeCallerId}'}), (callee:Function {id: '${safeCalleeId}'})
                       MERGE (caller)-[:Calls]->(callee)`
                    )
                  )

                  if (createCallsResult.error) {
                    console.error(
                      `Error creating Calls relationship by name match: ${createCallsResult.error}`
                    )
                  } else {
                    console.debug(
                      `Cross-file call by name match: ${sourceFile.fileName} -> ${sf.fileName}`
                    )
                  }
                }
              }
            }
          }
        }
      }

      // Continue traversing the call expression's children
      for (const child of node.getChildren()) {
        await visitNode(child)
      }
    } else {
      for (const child of node.getChildren()) {
        await visitNode(child)
      }
    }
  }

  function findFunctionsWithNameInFile(
    sf: ts.SourceFile,
    name: string
  ): ts.FunctionLikeDeclaration[] {
    const result: ts.FunctionLikeDeclaration[] = []

    function visit(node: ts.Node) {
      if (ts.isFunctionLike(node) && isFunctionLikeDeclaration(node)) {
        const funcName = getFunctionName(node)
        if (funcName === name) {
          result.push(node)
        }
      }

      // Check variable declarations
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        isFunctionLikeDeclaration(node.initializer)
      ) {
        result.push(node.initializer)
      }

      ts.forEachChild(node, visit)
    }

    visit(sf)
    return result
  }

  console.debug(`Starting AST traversal for ${filePath}`)
  await visitNode(sourceFile)
  console.debug(`Completed parsing for ${filePath}`)
}
