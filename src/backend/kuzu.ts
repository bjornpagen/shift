//@ts-ignore
import * as kuzu from "kuzu"
import { parseAndUpdateKuzu } from "./ts-parser"
import * as ts from "typescript"
import * as fs from "node:fs/promises"
import { tryCatch } from "../utils/try-catch"

export interface KuzuDatabase {
  path: string
}

export interface KuzuRow {
  [key: string]: string | number | boolean
}

export interface KuzuQueryResult<T extends KuzuRow = KuzuRow> {
  getAll(): Promise<T[]>
}

export interface KuzuConnection {
  query<T extends KuzuRow = KuzuRow>(
    queryString: string
  ): Promise<KuzuQueryResult<T>>
}

function getScriptKind(filePath: string): ts.ScriptKind {
  console.debug(`Determining script kind for ${filePath}`)
  const extension = filePath.split(".").pop()?.toLowerCase()
  switch (extension) {
    case "ts":
      console.debug(`Script kind for ${filePath}: TS`)
      return ts.ScriptKind.TS
    case "tsx":
      console.debug(`Script kind for ${filePath}: TSX`)
      return ts.ScriptKind.TSX
    default:
      console.debug(`Script kind for ${filePath}: Unknown`)
      return ts.ScriptKind.Unknown
  }
}

export async function initializeKuzu(
  storagePath: string
): Promise<KuzuConnection> {
  console.debug(`Initializing Kùzu database at ${storagePath}`)
  const dbPath = `${storagePath}/shift-v2-kuzu`

  const clearResult = await tryCatch(
    fs.rm(dbPath, { recursive: true, force: true })
  )
  if (clearResult.error) {
    console.debug(
      `Failed to clear Kùzu database at ${dbPath}: ${clearResult.error}`
    )
  } else {
    console.debug(`Cleared existing Kùzu database at ${dbPath}`)
  }

  const initPromise = (async (): Promise<KuzuConnection> => {
    console.debug(`Creating Kùzu database instance at ${dbPath}`)
    const db = new kuzu.Database(dbPath) as unknown as KuzuDatabase
    const conn = new kuzu.Connection(db) as unknown as KuzuConnection

    console.debug("Creating schema: File table")
    await conn.query("CREATE NODE TABLE File(path STRING, PRIMARY KEY (path))")
    console.debug("Created File node table")

    console.debug("Creating schema: Function table")
    await conn.query(
      "CREATE NODE TABLE Function(id STRING, name STRING, startLine INT, startColumn INT, endLine INT, endColumn INT, PRIMARY KEY (id))"
    )
    console.debug("Created Function node table")

    console.debug("Creating schema: HasFunction relationship")
    await conn.query("CREATE REL TABLE HasFunction(FROM File TO Function)")
    console.debug("Created HasFunction relationship table")

    console.debug("Creating schema: Calls relationship")
    await conn.query("CREATE REL TABLE Calls(FROM Function TO Function)")
    console.debug("Created Calls relationship table")

    console.debug(`Kùzu database initialized at ${dbPath}`)
    return conn
  })()

  const initResult = await tryCatch<KuzuConnection>(initPromise)

  if (initResult.error) {
    console.error(
      `Failed to initialize Kùzu database at ${dbPath}: ${initResult.error}`
    )
    throw initResult.error
  }

  console.debug("Kùzu initialization completed")
  return initResult.data
}

export async function updateKuzuDatabaseForProject(
  files: { path: string; content: string }[],
  conn: KuzuConnection
) {
  console.debug(`Updating Kùzu database for ${files.length} files`)
  const filesResult = await conn.query(
    "MATCH (f:File) RETURN count(f) as count"
  )
  const count = Number((await filesResult.getAll())[0].count)
  console.debug(`Database currently contains ${count} files`)
  if (count > 0) {
    console.debug("Database already populated, skipping update")
    return
  }

  console.debug("Creating source files for TypeScript processing")
  const sourceFiles = files.map((file) => {
    const scriptKind = getScriptKind(file.path)
    console.debug(
      `Creating source file for ${file.path}, content length: ${file.content.length}`
    )
    return ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind
    )
  })
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    jsx: ts.JsxEmit.React,
    strict: false,
    noEmit: true,
    skipLibCheck: true
  }
  console.debug("Setting up TypeScript compiler host")
  const host = ts.createCompilerHost(compilerOptions)
  host.getSourceFile = (fileName: string) => {
    const sf = sourceFiles.find((sf) => sf.fileName === fileName)
    console.debug(`Host requested source file: ${fileName}, found: ${!!sf}`)
    return sf
  }
  console.debug(`Creating TypeScript program with ${files.length} files`)
  const program = ts.createProgram(
    files.map((f) => f.path),
    compilerOptions,
    host
  )
  const typeChecker = program.getTypeChecker()
  console.debug("Type checker initialized")

  for (const file of files) {
    console.debug(`Processing file for database: ${file.path}`)
    const safeFilePath = file.path.replace(/'/g, "''")
    await conn.query(`CREATE (f:File {path: '${safeFilePath}'})`)
    const sourceFile = program.getSourceFile(file.path)
    if (sourceFile) {
      console.debug(`Parsing and updating Kùzu for ${file.path}`)
      await parseAndUpdateKuzu(conn, sourceFile, program, typeChecker)
    } else {
      console.debug(`Source file not found for ${file.path}`)
    }
  }
  console.debug("Database update for project completed")
}

export async function updateKuzuDatabase(
  filePath: string,
  content: string,
  conn: KuzuConnection
): Promise<void> {
  console.debug(`Updating Kùzu database for ${filePath}`)

  const safeFilePath = filePath.replace(/'/g, "''")

  // Create source file for the updated content
  const scriptKind = getScriptKind(filePath)
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  )

  // Set up compiler options and create program for type checking
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    jsx: ts.JsxEmit.React,
    strict: false,
    noEmit: true,
    skipLibCheck: true
  }

  // Create compiler host
  const host = ts.createCompilerHost(compilerOptions)
  const originalGetSourceFile = host.getSourceFile
  host.getSourceFile = (fileName: string, languageVersion: ts.ScriptTarget) => {
    if (fileName === filePath) {
      return sourceFile
    }
    return originalGetSourceFile(fileName, languageVersion)
  }

  // Create program with just this file
  const program = ts.createProgram([filePath], compilerOptions, host)
  const typeChecker = program.getTypeChecker()

  // Query existing functions for this file
  console.debug(`Retrieving existing functions for ${filePath}`)
  const existingFunctionsQueryResult = await tryCatch(
    conn.query<{
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

  if (existingFunctionsQueryResult.error) {
    console.error(
      `Error retrieving existing functions: ${existingFunctionsQueryResult.error}`
    )
    throw existingFunctionsQueryResult.error
  }

  const existingFunctionsDataResult = await tryCatch(
    existingFunctionsQueryResult.data.getAll()
  )

  if (existingFunctionsDataResult.error) {
    console.error(
      `Error getting function data: ${existingFunctionsDataResult.error}`
    )
    throw existingFunctionsDataResult.error
  }

  const existingFunctions = existingFunctionsDataResult.data
  console.debug(`Found ${existingFunctions.length} existing functions`)

  // Collect new functions by parsing the updated file
  const newFunctionIds = new Set<string>()

  // First create or ensure file node exists
  const mergeFileResult = await tryCatch(
    conn.query(`MERGE (f:File {path: '${safeFilePath}'})`)
  )

  if (mergeFileResult.error) {
    console.error(`Error ensuring file node exists: ${mergeFileResult.error}`)
    throw mergeFileResult.error
  }

  // Parse the file and update the database
  // This will add new functions and update existing ones
  const parseResult = await tryCatch(
    parseAndUpdateKuzu(conn, sourceFile, program, typeChecker)
  )

  if (parseResult.error) {
    console.error(`Error parsing and updating Kuzu: ${parseResult.error}`)
    throw parseResult.error
  }

  // Collect all function IDs that should exist after the update
  const visitor = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node)
    ) {
      const functionId = `${filePath}:${node.pos}`
      newFunctionIds.add(functionId)
    }

    ts.forEachChild(node, visitor)
  }

  ts.forEachChild(sourceFile, visitor)

  // Delete functions that no longer exist in the file
  for (const func of existingFunctions) {
    if (!newFunctionIds.has(func.id)) {
      console.debug(`Removing function ${func.name} (ID: ${func.id})`)

      // Delete all connected Calls relationships first
      const deleteCallsResult = await tryCatch(
        conn.query(
          `MATCH (func:Function {id: '${func.id.replace(/'/g, "''")}'})-[r:Calls]-()
           DELETE r`
        )
      )

      if (deleteCallsResult.error) {
        console.error(
          `Error deleting Calls relationships for ${func.id}: ${deleteCallsResult.error}`
        )
        // Continue despite the error to attempt node deletion
      }

      // Then delete the Function node and its HasFunction relationship
      const deleteResult = await tryCatch(
        conn.query(
          `MATCH (f:File {path: '${safeFilePath}'})-[r:HasFunction]->(func:Function {id: '${func.id.replace(/'/g, "''")}'})
           DELETE r, func`
        )
      )

      if (deleteResult.error) {
        console.error(
          `Error deleting function ${func.id}: ${deleteResult.error}`
        )
        console.error("Will continue with other operations")
      }
    }
  }

  console.debug(`Database update completed for ${filePath}`)
}
