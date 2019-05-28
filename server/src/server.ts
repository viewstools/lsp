/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
  createConnection,
  TextDocuments,
  TextDocument,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  Position,
} from 'vscode-languageserver'
import {
  addToMapSet,
  getFilesView,
  getFilesViewCustom,
  getFilesFontCustom,
  getViewIdFromFile,
  processCustomFonts,
} from '@viewstools/morph/lib.js'
import * as pkgUp from 'pkg-up'
import * as parseView from '@viewstools/morph/parse.js'
import * as path from 'path'

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all)

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments()

let hasConfigurationCapability: boolean = false
let hasWorkspaceFolderCapability: boolean = false
let hasDiagnosticRelatedInformationCapability: boolean = false

async function getViewsContext(file: string) {
  let customFonts = new Map()
  let viewsById = new Map()
  let verbose = false

  let pkg = (await pkgUp({ cwd: file })) || file
  let src = path.dirname(pkg)

  connection.console.log(`>>>>> ${src}`)

  let [
    filesView,
    filesViewCustom,
    filesFontCustom,
  ] = await Promise.all([
    getFilesView(src),
    getFilesViewCustom(src),
    getFilesFontCustom(src),
  ])

  for (let file of filesView) {
    let id = getViewIdFromFile(file)
    addToMapSet(viewsById, id, file)
  }
  for (let file of filesViewCustom) {
    let id = getViewIdFromFile(file)
    addToMapSet(viewsById, id, file)
  }

  processCustomFonts({ customFonts, filesFontCustom })

  return { viewsById, customFonts }
}

connection.onInitialize((params: InitializeParams) => {
  let capabilities = params.capabilities

  // Does the client support the `workspace/configuration` request?
  // If not, we will fall back using global settings
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  )
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  )
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  )

  return {
    capabilities: {
      textDocumentSync: documents.syncKind,
      // Tell the client that the server supports code completion
      completionProvider: {
        resolveProvider: true,
      },
    },
  }
})

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined
    )
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(_event => {
      connection.console.log('Workspace folder change event received.')
    })
  }
})

// The example settings
interface ExampleSettings {
  maxNumberOfProblems: number
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 }
let globalSettings: ExampleSettings = defaultSettings

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<ExampleSettings>> = new Map()

connection.onDidChangeConfiguration(change => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear()
  } else {
    globalSettings = <ExampleSettings>(
      (change.settings.languageServerViews || defaultSettings)
    )
  }

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument)
})

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings)
  }
  let result = documentSettings.get(resource)
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: 'languageServerViews',
    })
    documentSettings.set(resource, result)
  }
  return result
}

// Only keep settings for open documents
documents.onDidClose(e => {
  documentSettings.delete(e.document.uri)
})

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
  validateTextDocument(change.document)
})

interface ViewsWarningLocPoint {
  line: number
  column: number
}

interface ViewsWarningLoc {
  start: ViewsWarningLocPoint
  end: ViewsWarningLocPoint
}

interface ViewsWarning {
  loc: ViewsWarningLoc
  type: string
  line: string
}

let mapPosition = (pos: ViewsWarningLocPoint): Position => ({
  line: pos.line - 1,
  character: pos.column,
})

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  // In this simple example we get the settings for every validate run.
  // let settings = await getDocumentSettings(textDocument.uri)
  
  connection.console.log(`OOOO* ${textDocument.uri}`)

  let { customFonts, viewsById } = await getViewsContext(textDocument.uri)

  let source = textDocument.getText()
  
  let parsed = parseView({
    customFonts: customFonts,
    views: viewsById,
    source,
    skipComments: false,
    convertSlotToProps: false,
  })

  let diagnostics: Diagnostic[] = parsed.warnings.map(
    (warning: ViewsWarning) => {
      let diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Warning,
        range: {
          start: mapPosition(warning.loc.start), // warning.textDocument.positionAt(m.index),
          end: mapPosition(warning.loc.end), // textDocument.positionAt(m.index + m[0].length),
        },
        message: warning.type,
        source: 'ex',
      }
      return diagnostic
    }
  )

  // Send the computed diagnostics to VSCode.
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics })
}

connection.onDidChangeWatchedFiles(_change => {
  // Monitored files have change in VSCode
  connection.console.log('We received an file change event')
})

// This handler provides the initial list of the completion items.
connection.onCompletion(
  (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    return [
      {
        label: 'TypeScript',
        kind: CompletionItemKind.Text,
        data: 1,
      },
      {
        label: 'JavaScript',
        kind: CompletionItemKind.Text,
        data: 2,
      },
    ]
  }
)

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
  (item: CompletionItem): CompletionItem => {
    if (item.data === 1) {
      item.detail = 'TypeScript details'
      item.documentation = 'TypeScript documentation'
    } else if (item.data === 2) {
      item.detail = 'JavaScript details'
      item.documentation = 'JavaScript documentation'
    }
    return item
  }
)

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection)

// Listen on the connection
connection.listen()
