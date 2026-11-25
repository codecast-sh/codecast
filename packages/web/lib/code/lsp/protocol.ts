// The slice of the Language Server Protocol (3.17) the editor speaks, typed
// here rather than imported: vscode-languageserver-protocol is not one of this
// repo's dependencies (lsp-client imports it for types only), so importing it
// would bind to whatever copy a machine happens to have up the tree.

export type URI = string;

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Location {
  uri: URI;
  range: Range;
}
export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: URI;
  targetRange: Range;
  targetSelectionRange: Range;
}
export interface TextEdit {
  range: Range;
  newText: string;
}
export interface TextDocumentIdentifier {
  uri: URI;
}
export interface TextDocumentPositionParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
}

export interface TextDocumentEdit {
  textDocument: { uri: URI; version: number | null };
  edits: TextEdit[];
}
export interface CreateFile {
  kind: "create";
  uri: URI;
}
export interface RenameFile {
  kind: "rename";
  oldUri: URI;
  newUri: URI;
}
export interface DeleteFile {
  kind: "delete";
  uri: URI;
}
export interface WorkspaceEdit {
  changes?: { [uri: URI]: TextEdit[] };
  documentChanges?: (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[];
}
export interface ApplyWorkspaceEditParams {
  label?: string;
  edit: WorkspaceEdit;
}

export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}
export type MarkedString = string | { language: string; value: string };

export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface CompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  detail?: string;
  documentation?: string | MarkupContent;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: 1 | 2;
  textEdit?: TextEdit | { newText: string; insert: Range; replace: Range };
  textEditText?: string;
  additionalTextEdits?: TextEdit[];
  commitCharacters?: string[];
  command?: Command;
  data?: unknown;
}
export interface CompletionList {
  isIncomplete: boolean;
  itemDefaults?: {
    commitCharacters?: string[];
    editRange?: Range | { insert: Range; replace: Range };
    insertTextFormat?: 1 | 2;
    data?: unknown;
  };
  items: CompletionItem[];
}
export type CompletionContext = { triggerKind: 1 | 3 } | { triggerKind: 2; triggerCharacter: string };
export interface CompletionParams extends TextDocumentPositionParams {
  context?: CompletionContext;
}

export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: number | string;
  source?: string;
  message: string;
  /** 1 unnecessary, 2 deprecated. */
  tags?: number[];
}
export interface PublishDiagnosticsParams {
  uri: URI;
  version?: number;
  diagnostics: Diagnostic[];
}

export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}
export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}
export interface WorkspaceSymbol {
  name: string;
  kind: number;
  location: Location | { uri: URI };
  containerName?: string;
}
export interface WorkspaceSymbolParams {
  query: string;
}

export interface CodeActionContext {
  diagnostics: Diagnostic[];
  only?: string[];
  triggerKind?: 1 | 2;
}
export interface CodeActionParams {
  textDocument: TextDocumentIdentifier;
  range: Range;
  context: CodeActionContext;
}
export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: WorkspaceEdit;
  command?: Command;
  data?: unknown;
}

export interface RenameParams extends TextDocumentPositionParams {
  newName: string;
}
export type PrepareRenameResult = Range | { range: Range; placeholder: string } | { defaultBehavior: boolean };

export interface FormattingOptions {
  tabSize: number;
  insertSpaces: boolean;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
}
export interface DocumentFormattingParams {
  textDocument: TextDocumentIdentifier;
  options: FormattingOptions;
}
export interface ReferenceParams extends TextDocumentPositionParams {
  context: { includeDeclaration: boolean };
}

/** What the commands check before asking; other keys pass through untyped. */
export interface ServerCapabilities {
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  hoverProvider?: unknown;
  definitionProvider?: unknown;
  typeDefinitionProvider?: unknown;
  implementationProvider?: unknown;
  referencesProvider?: unknown;
  documentSymbolProvider?: unknown;
  workspaceSymbolProvider?: unknown;
  codeActionProvider?: boolean | { resolveProvider?: boolean };
  documentFormattingProvider?: unknown;
  renameProvider?: boolean | { prepareProvider?: boolean };
  [key: string]: unknown;
}

/** The server's capabilities as the client holds them (null before initialize). */
export function capabilitiesOf(client: { serverCapabilities: unknown }): ServerCapabilities | null {
  return (client.serverCapabilities as ServerCapabilities | null) ?? null;
}

/** False only when the server said it cannot; unknown (still starting) tries. */
export function serverCan(client: { serverCapabilities: unknown }, cap: keyof ServerCapabilities): boolean {
  const caps = capabilitiesOf(client);
  return caps ? !!caps[cap] : true;
}
