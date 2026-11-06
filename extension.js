"use strict";

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { openComparePanel, readSqlConnections, listDatabases } = require("./comparePanel");
const { createPublishPanel } = require("./publishPanel");
const { compileProject, cleanProject, readLocalSaPassword } = require("./projectBuild");
const { t } = require("./l10n");

let diagnostics;
let output;

const SKIP_DIRECTORIES = new Set(["bin", "obj", "Properties", "node_modules", ".git", ".vs"]);

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("johnnySchemaCompare");
  output = vscode.window.createOutputChannel("Johnny Schema Compare");
  const provider = new ProjectTreeProvider();
  context.subscriptions.push(
    diagnostics,
    output,
    vscode.window.registerTreeDataProvider("johnnySchemaCompare.main", provider)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("johnnySchemaCompare.open", () => {
      return vscode.commands.executeCommand("johnnySchemaCompare.main.focus");
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("johnnySchemaCompare.openFile", (uri) => {
      return vscode.window.showTextDocument(asUri(uri), { preview: false });
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("johnnySchemaCompare.compare", (node) => {
      return openComparePanel(context, node);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("johnnySchemaCompare.clean", (node) => cleanAction(node)),
    vscode.commands.registerCommand("johnnySchemaCompare.build", (node) => buildAction(context, node)),
    vscode.commands.registerCommand("johnnySchemaCompare.publish", (node) => publishAction(context, node))
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{sql,sqlproj}");
  const refresh = () => provider.refresh();
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(refresh),
    watcher.onDidDelete(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh)
  );
}

class ProjectTreeProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }

  refresh() {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element) {
    return element.item;
  }

  async getChildren(element) {
    if (!element) {
      return projectNodes();
    }
    if (element.kind === "project") {
      return projectChildren(element.dir);
    }
    if (element.kind === "folder") {
      return directoryChildren(element.dir);
    }
    return [];
  }
}

async function projectNodes() {
  const uris = await vscode.workspace.findFiles(
    "**/*.sqlproj",
    "{**/node_modules/**,**/.git/**,**/bin/**,**/obj/**}"
  );
  return uris
    .map((uri) => {
      const name = path.basename(uri.fsPath).replace(/\.sqlproj$/i, "");
      const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = "sqlProject";
      item.tooltip = vscode.workspace.asRelativePath(uri, true);
      item.iconPath = new vscode.ThemeIcon("database");
      return {
        kind: "project",
        name,
        dir: path.dirname(uri.fsPath),
        projectFile: uri.fsPath,
        item,
      };
    })
    .sort(byItemLabel);
}

function projectChildren(dir) {
  const headings = [
    heading(t("Database references"), "references"),
    heading(t("SQLCMD variables"), "symbol-variable"),
  ];
  return headings.concat(directoryChildren(dir).filter((child) => child.kind === "folder"));
}

function directoryChildren(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const folders = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = "sqlFolder";
      item.iconPath = new vscode.ThemeIcon("folder");
      item.tooltip = fullPath;
      folders.push({ kind: "folder", dir: fullPath, item });
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".sql")) {
      const uri = vscode.Uri.file(fullPath);
      const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
      item.contextValue = "sqlFile";
      item.resourceUri = uri;
      item.tooltip = fullPath;
      item.command = {
        command: "johnnySchemaCompare.openFile",
        title: "Abrir",
        arguments: [uri],
      };
      files.push({ kind: "file", item });
    }
  }

  folders.sort(byItemLabel);
  files.sort(byItemLabel);
  return folders.concat(files);
}

function publishAction(context, node) {
  const projectFile = node && node.projectFile;
  const name = node && node.name ? node.name : t("the project");
  if (!projectFile) {
    return vscode.window.showInformationMessage(t("Choose the project in the tree."));
  }
  const panel = createPublishPanel(context, projectFile, name);
  panel.webview.onDidReceiveMessage((message) => onPublishMessage(context, panel, projectFile, name, message));
  return panel;
}

async function onPublishMessage(context, panel, projectFile, name, message) {
  if (!message || typeof message.type !== "string") {
    return;
  }
  if (message.type === "cancel") {
    panel.dispose();
    return;
  }
  if (message.type === "refreshConnections") {
    panel.webview.postMessage({ type: "connections", connections: readSqlConnections() });
    return;
  }
  if (message.type === "listDatabases") {
    const connection = readSqlConnections().find((item) => (item.id || item.profileName) === message.connectionId);
    const databases = connection ? await listDatabases(connection) : [];
    panel.webview.postMessage({ type: "databases", connectionId: message.connectionId, databases });
    return;
  }
  if (message.type !== "publish") {
    return;
  }

  const connection = readSqlConnections().find((item) => (item.id || item.profileName) === message.connectionId);
  const database = String(message.database || "");
  if (!connection || !/^[A-Za-z0-9_]+$/.test(database)) {
    panel.webview.postMessage({ type: "done", text: t("Choose the connection and the database.") });
    return;
  }
  const host = String(connection.server || "").split(",")[0].trim().toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== ".") {
    panel.webview.postMessage({ type: "done", text: t("Publish only targets the local database.") });
    return vscode.window.showErrorMessage(t("Publish only targets the local database."));
  }

  let password = "";
  try {
    password = await readLocalSaPassword();
  } catch {
    panel.webview.postMessage({ type: "done", text: t("Could not read the local engine.") });
    return vscode.window.showErrorMessage(t("Could not read the local engine to publish."));
  }

  clearProjectDiagnostics(path.dirname(projectFile));
  output.clear();
  output.appendLine(t("Publish {0} to {1}", projectFile, database));
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t("Publishing {0} to {1}", name, database),
      cancellable: true,
    },
    (progress, token) => {
      progress.report({ message: t("compiling") });
      return compileProject(context.extensionPath, projectFile, {
        token,
        database,
        server: connection.server,
        password,
        language: vscode.env.language,
        onProgress(current, total) {
          progress.report({ message: t("compiling {0} / {1}", current, total) });
        },
        onStatus(text) {
          progress.report({ message: text });
          output.appendLine(text);
        },
      });
    }
  );
  password = "";

  if (result.cancelled) {
    panel.webview.postMessage({ type: "done", text: t("Cancelled.") });
    return vscode.window.showInformationMessage(t("Publish {0}: cancelled.", name));
  }
  if (result.fatal) {
    const fatal = t(result.fatal);
    output.appendLine(fatal);
    output.show(true);
    panel.webview.postMessage({ type: "done", text: fatal });
    return vscode.window.showErrorMessage(t("Publish {0}: {1}", name, fatal));
  }

  const items = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  applyDiagnostics(projectFile, items);
  const errors = items.filter((item) => item.severity !== "warning");
  const warnings = items.filter((item) => item.severity === "warning");
  for (const item of items) {
    const where = item.file ? item.file + "(" + item.line + "," + item.column + ")" : projectFile;
    output.appendLine(where + ": " + item.severity + ": " + item.message);
  }

  if (!result.published) {
    output.show(true);
    const text = errors.length
      ? t("Not published. {0} errors.", errors.length)
      : t("Not published.");
    panel.webview.postMessage({ type: "done", text });
    const choice = await vscode.window.showErrorMessage(t("Publish {0}: {1}", name, text), t("See problems"));
    if (choice) {
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    }
    return;
  }

  const warningText = warnings.length ? " " + t("{0} warnings.", warnings.length) : "";
  output.appendLine(t("Publish {0}: ready on {1}.", name, database) + warningText);
  panel.webview.postMessage({ type: "done", text: t("Ready on {0}.", database) + warningText });
  if (warnings.length > 0) {
    output.show(true);
    const choice = await vscode.window.showWarningMessage(
      t("Publish {0}: ready on {1}.", name, database) + warningText,
      t("See problems")
    );
    if (choice) {
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    }
    return;
  }
  return vscode.window.showInformationMessage(t("Publish {0}: ready on {1}.", name, database));
}

function cleanAction(node) {
  const projectFile = node && node.projectFile;
  const name = node && node.name ? node.name : "";
  if (!projectFile) {
    return vscode.window.showInformationMessage(t("Choose the project in the tree."));
  }

  output.clear();
  output.appendLine(
    t("---------- Clean started: Project: {0}, Configuration: Debug Any CPU ----------", name)
  );
  const result = cleanProject(projectFile);
  clearProjectDiagnostics(path.dirname(projectFile));
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      output.appendLine(name + ": " + error);
    }
    output.appendLine(t("========== Clean: 0 succeeded, 1 failed, 0 skipped =========="));
    output.show(true);
    return vscode.window.showErrorMessage(t("Clean {0}: could not clean.", name));
  }
  if (result.removed.length === 0) {
    output.appendLine(t("The project was already clean."));
  } else {
    output.appendLine(t("Removed {0}.", result.removed.join(", ")));
  }
  output.appendLine(t("========== Clean: 1 succeeded, 0 failed, 0 skipped =========="));
  output.show(true);
  const detail = result.removed.length ? t("Removed bin and obj.") : t("Already clean.");
  return vscode.window.showInformationMessage(t("Clean {0}: {1}", name, detail));
}

async function buildAction(context, node) {
  const projectFile = node && node.projectFile;
  const name = node && node.name ? node.name : t("the project");
  if (!projectFile) {
    return vscode.window.showInformationMessage(t("Choose the project in the tree."));
  }

  clearProjectDiagnostics(path.dirname(projectFile));
  output.clear();
  output.appendLine(t("Build {0}", projectFile));

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t("Building {0}", name),
      cancellable: true,
    },
    (progress, token) => {
      progress.report({ message: t("reading the project") });
      return compileProject(context.extensionPath, projectFile, {
        token,
        language: vscode.env.language,
        onProgress(current, total) {
          progress.report({ message: current + " / " + total });
        },
      });
    }
  );

  if (result.cancelled) {
    return vscode.window.showInformationMessage(t("Build {0}: cancelled.", name));
  }
  if (result.fatal) {
    const fatal = t(result.fatal);
    output.appendLine(fatal);
    output.show(true);
    return vscode.window.showErrorMessage(t("Build {0}: {1}", name, fatal));
  }

  const items = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  applyDiagnostics(projectFile, items);
  const errors = items.filter((item) => item.severity !== "warning");
  const warnings = items.filter((item) => item.severity === "warning");
  for (const item of items) {
    const where = item.file ? `${item.file}(${item.line},${item.column})` : projectFile;
    output.appendLine(`${where}: ${item.severity}: ${item.message}`);
  }

  if (errors.length > 0) {
    output.appendLine(t("Build {0}: {1} errors, {2} warnings.", name, errors.length, warnings.length));
    output.show(true);
    const choice = await vscode.window.showErrorMessage(
      t("Build {0}: {1} errors.", name, errors.length),
      t("See problems")
    );
    if (choice) {
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    }
    return;
  }

  const dacpac = result.dacpac ? path.relative(path.dirname(projectFile), result.dacpac) : "";
  const ready = dacpac ? " " + t("Wrote {0}.", dacpac) : "";
  if (warnings.length > 0) {
    output.appendLine(t("Build {0}: {1} warnings.", name, warnings.length));
    output.show(true);
    const choice = await vscode.window.showWarningMessage(
      t("Build {0}: no errors. {1} warnings.{2}", name, warnings.length, ready),
      t("See problems")
    );
    if (choice) {
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    }
    return;
  }
  return vscode.window.showInformationMessage(t("Build {0}: no errors.{1}", name, ready));
}

function applyDiagnostics(projectFile, items) {
  const groups = new Map();
  for (const item of items) {
    const file = item.file || projectFile;
    if (!groups.has(file)) {
      groups.set(file, []);
    }
    const line = Math.max(0, (Number(item.line) || 1) - 1);
    const column = Math.max(0, (Number(item.column) || 1) - 1);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(line, column, line, column + 1),
      item.message || "Error",
      item.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = "Johnny Schema Compare";
    groups.get(file).push(diagnostic);
  }
  for (const [file, list] of groups) {
    diagnostics.set(vscode.Uri.file(file), list);
  }
}

function clearProjectDiagnostics(dir) {
  const root = path.resolve(dir);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  for (const [uri] of diagnostics) {
    if (uri.fsPath === root || uri.fsPath.startsWith(prefix)) {
      diagnostics.delete(uri);
    }
  }
}

function heading(label, icon) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.contextValue = "sqlHeading";
  item.iconPath = new vscode.ThemeIcon(icon);
  return { kind: "heading", item };
}

function byItemLabel(a, b) {
  return a.item.label.localeCompare(b.item.label, "es", { sensitivity: "base" });
}

function asUri(value) {
  if (value instanceof vscode.Uri) {
    return value;
  }
  if (value && typeof value.fsPath === "string") {
    return vscode.Uri.file(value.fsPath);
  }
  if (value && typeof value.path === "string") {
    return vscode.Uri.file(value.path);
  }
  return vscode.Uri.file(String(value));
}

function deactivate() {}

module.exports = { activate, deactivate };
