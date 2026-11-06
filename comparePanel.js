"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { buildNameDiff, readObjectScript } = require("./compareEngine");
const { applySelectionToDatabase, applySelectionToProject } = require("./projectApply");
const { t, webviewL10nScript } = require("./l10n");
const compareViewScript = fs.readFileSync(path.join(__dirname, "compareView.js"), "utf8");

const defaultOptions = {
  excludePermissions: true,
  excludeRoleMembership: true,
  excludeUsers: true,
};

async function openComparePanel(context, node) {
  const panel = vscode.window.createWebviewPanel(
    "johnnySchemaCompare.compare",
    t("Compare schema"),
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "Logo", "Comparar128.png");

  const state = {
    source: node && node.projectFile ? { kind: "project", value: node.projectFile } : null,
    target: null,
    options: { ...defaultOptions },
  };
  const connections = readSqlConnections();
  const projects = await findSqlProjects();
  panel.webview.html = compareHtml(state, connections, projects);
  panel.webview.onDidReceiveMessage((message) => onMessage(panel, message));
  return panel;
}

function readSqlConnections() {
  const list = vscode.workspace.getConfiguration("mssql").get("connections");
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: String(item.id || ""),
      profileName: String(item.profileName || item.server || "").trim(),
      server: String(item.server || "").trim(),
      database: String(item.database || "").trim(),
    }))
    .filter((item) => item.profileName);
}

async function listDatabases(connection) {
  const saved = connection.database ? [connection.database] : [];
  const host = String(connection.server || "").split(",")[0].trim().toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== ".") {
    return saved;
  }
  try {
    const names = await listLocalContainerDatabases();
    return names.length ? names : saved;
  } catch {
    return saved;
  }
}

function listLocalContainerDatabases() {
  const query = [
    "SQLCMD=/opt/mssql-tools18/bin/sqlcmd",
    "if [ ! -x \"$SQLCMD\" ]; then SQLCMD=/opt/mssql-tools/bin/sqlcmd; fi",
    "if [ -z \"$MSSQL_SA_PASSWORD\" ] || [ ! -x \"$SQLCMD\" ]; then exit 2; fi",
    "\"$SQLCMD\" -C -S localhost -U sa -P \"$MSSQL_SA_PASSWORD\" -h -1 -W -Q \"SET NOCOUNT ON; SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0 ORDER BY name\"",
  ].join("; ");
  const bins = ["docker", "/usr/local/bin/docker"];
  const containers = ["sqlserver", "localhost"];

  const attempt = (binIndex, containerIndex) => {
    if (binIndex >= bins.length) {
      return Promise.reject(new Error("docker"));
    }
    if (containerIndex >= containers.length) {
      return attempt(binIndex + 1, 0);
    }
    return execFileText(bins[binIndex], ["exec", containers[containerIndex], "bash", "-lc", query]).catch(() =>
      attempt(binIndex, containerIndex + 1)
    );
  };

  return attempt(0, 0).then((stdout) =>
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("Msg") && !/rows affected/i.test(line))
  );
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

async function findSqlProjects() {
  const uris = await vscode.workspace.findFiles(
    "**/*.sqlproj",
    "{**/node_modules/**,**/.git/**,**/bin/**,**/obj/**}"
  );
  return uris
    .map((uri) => ({
      name: path.basename(uri.fsPath).replace(/\.sqlproj$/i, ""),
      value: uri.fsPath,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
}

async function onMessage(panel, message) {
  if (!message || typeof message.type !== "string") {
    return;
  }
  if (message.type === "refreshConnections") {
    panel.webview.postMessage({ type: "connections", connections: readSqlConnections() });
    return;
  }
  if (message.type === "listDatabases") {
    const connection = readSqlConnections().find(
      (item) => (item.id || item.profileName) === message.connectionId
    );
    const databases = connection ? await listDatabases(connection) : [];
    panel.webview.postMessage({
      type: "databases",
      connectionId: message.connectionId,
      databases,
    });
    return;
  }
  if (message.type === "compare") {
    const token = (panel.compareToken || 0) + 1;
    panel.compareToken = token;
    try {
      const rows = await buildNameDiff(message.source, message.target);
      if (panel.compareToken !== token) {
        return;
      }
      panel.webview.postMessage({ type: "compared", rows });
    } catch (error) {
      if (panel.compareToken !== token) {
        return;
      }
      panel.webview.postMessage({ type: "compareFailed", message: error.message || t("Could not compare") });
    }
    return;
  }
  if (message.type === "stopCompare") {
    panel.compareToken = (panel.compareToken || 0) + 1;
    return;
  }
  if (message.type === "apply") {
    if (panel.applying) return;
    panel.applying = true;
    panel.webview.postMessage({ type: "applying", text: t("Applying…") });
    try {
      const toDatabase = message.source && message.source.kind === "project" && message.target && message.target.kind === "database";
      const result = toDatabase
        ? await applySelectionToDatabase(message.source, message.target, message.rows, (current, total, name) => {
          panel.webview.postMessage({ type: "applying", text: t("Applying {0} of {1}: {2}", current, total, name) });
        })
        : await applySelectionToProject(message.source, message.target, message.rows);
      if (result.cancelled) {
        return;
      }
      if (result.empty) {
        vscode.window.showInformationMessage(toDatabase
          ? t("No objects are checked that can be applied.")
          : t("Checked tables were not written. Their script still lacks indexes and defaults."));
        return;
      }
      const tableNote = result.skippedTables ? " " + t("{0} tables were not touched.", result.skippedTables) : "";
      if (toDatabase) {
        const database = message.target && message.target.value ? message.target.value : t("the database");
        const failures = Array.isArray(result.failures) ? result.failures : [];
        const total = result.applied + failures.length;
        if (failures.length) {
          const lines = failures.slice(0, 3).map((item) => `${item.name}: ${item.reason}`);
          const more = failures.length > 3 ? "\n" + t("… and {0} more.", failures.length - 3) : "";
          await vscode.window.showWarningMessage(
            t("Applied {0} of {1} on {2}. Failed: {3}.", result.applied, total, database, failures.length) + "\n" + lines.join("\n") + more,
            { modal: true }
          );
        } else {
          await vscode.window.showInformationMessage(
            t("Applied {0} objects on {1}.", result.applied, database),
            { modal: true }
          );
        }
        return;
      }
      await vscode.window.showInformationMessage(
        t("Project updated: {0} written, {1} removed.{2}", result.written, result.removed, tableNote),
        { modal: true }
      );
    } catch (error) {
      vscode.window.showErrorMessage(error.message || t("Could not apply the changes to the project"));
    } finally {
      panel.applying = false;
      panel.webview.postMessage({ type: "applied" });
    }
    return;
  }
  if (message.type === "script") {
    try {
      const script = await readObjectScript(message.row, message.database);
      panel.webview.postMessage({ type: "script", id: message.id, ...script });
    } catch (error) {
      panel.webview.postMessage({
        type: "script",
        id: message.id,
        sourceText: "",
        targetText: error.message || "",
      });
    }
    return;
  }
  if (message.type === "browseFile") {
    const value = await browseFile(message.fileKind);
    if (value) {
      panel.webview.postMessage({ type: "filePicked", fileKind: message.fileKind, value });
    }
    return;
  }
  if (message.type === "save") {
    await saveCompare(message.state);
    return;
  }
  if (message.type === "open") {
    const state = await openCompare();
    if (state) {
      panel.webview.postMessage({ type: "state", state });
    }
  }
}

async function browseFile(fileKind) {
  const dacpac = fileKind === "dacpac";
  const picked = await vscode.window.showOpenDialog({
    title: dacpac ? t("Dacpac file") : t("Database project"),
    canSelectMany: false,
    canSelectFiles: true,
    filters: dacpac
      ? { [t("Data-tier application")]: ["dacpac"] }
      : { [t("SQL project")]: ["sqlproj"] },
  });
  if (!picked || !picked[0]) {
    return null;
  }
  return picked[0].fsPath;
}

async function saveCompare(state) {
  const uri = await vscode.window.showSaveDialog({
    title: t("Save .scmp"),
    filters: { "Schema Compare": ["scmp"] },
    defaultUri: defaultScmpUri(state),
  });
  if (!uri) {
    return;
  }
  const text = JSON.stringify(normalizeState(state), null, 2);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

async function openCompare() {
  const picked = await vscode.window.showOpenDialog({
    title: t("Open .scmp"),
    canSelectMany: false,
    filters: { "Schema Compare": ["scmp"] },
  });
  if (!picked || !picked[0]) {
    return null;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(picked[0]);
    return normalizeState(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch {
    vscode.window.showErrorMessage(t("Could not open that .scmp."));
    return null;
  }
}

function defaultScmpUri(state) {
  const source = state && state.source;
  if (source && source.kind === "project" && source.value) {
    const dir = path.dirname(source.value);
    const name = path.basename(source.value).replace(/\.sqlproj$/i, "");
    return vscode.Uri.file(path.join(dir, `${name}.scmp`));
  }
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const base = folder ? folder.uri.fsPath : "";
  return vscode.Uri.file(path.join(base, t("Compare") + ".scmp"));
}

function normalizeState(data) {
  const options = data && data.options ? data.options : {};
  return {
    source: normalizeEndpoint(data && data.source),
    target: normalizeEndpoint(data && data.target),
    options: {
      excludePermissions: options.excludePermissions !== false,
      excludeRoleMembership: options.excludeRoleMembership !== false,
      excludeUsers: options.excludeUsers !== false,
    },
  };
}

function normalizeEndpoint(value) {
  if (!value || (value.kind !== "project" && value.kind !== "database" && value.kind !== "dacpac")) {
    return null;
  }
  if (typeof value.value !== "string" || !value.value.trim()) {
    return null;
  }
  const endpoint = { kind: value.kind, value: value.value.trim() };
  if (value.kind === "database") {
    if (typeof value.profileName === "string" && value.profileName) {
      endpoint.profileName = value.profileName;
    }
    if (typeof value.server === "string" && value.server) {
      endpoint.server = value.server;
    }
    if (typeof value.connectionId === "string" && value.connectionId) {
      endpoint.connectionId = value.connectionId;
    }
  }
  return endpoint;
}

function compareHtml(state, connections, projects) {
  const boot = JSON.stringify({ state, connections, projects }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body {
    margin: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    overflow: hidden;
  }
  button {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid transparent;
    border-radius: 2px;
    padding: 4px 8px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font: inherit;
    white-space: nowrap;
  }
  button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  button:disabled { opacity: 0.4; cursor: default; }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
    flex-wrap: wrap;
  }
  .sep {
    width: 1px;
    align-self: stretch;
    margin: 4px 8px;
    background: var(--vscode-widget-border, rgba(128,128,128,.35));
  }
  .options {
    display: none;
    padding: 8px 16px 12px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
  }
  .options.open { display: block; }
  .options h2 { font-size: 12px; font-weight: 600; margin: 0 0 6px; }
  .options label { display: flex; gap: 8px; align-items: center; margin: 4px 0; }
  .ends {
    display: grid;
    grid-template-columns: minmax(0,1fr) auto minmax(0,1fr) auto;
    gap: 12px;
    align-items: end;
    padding: 12px;
  }
  .end label { display: block; margin-bottom: 4px; }
  .box {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 4px 0 8px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.45));
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
  }
  .box svg { flex: 0 0 auto; opacity: 0.9; }
  .box input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    outline: none;
  }
  .swap { align-self: center; margin-top: 18px; }
  #compareSide {
    height: 28px;
    margin-bottom: 1px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  #results {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--vscode-descriptionForeground);
  }
  body.busy, body.busy * { cursor: wait !important; }
  .apply-status {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: rgba(0,0,0,.45);
    color: var(--vscode-foreground);
  }
  .apply-status[hidden] { display: none !important; }
  .comparing {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    color: var(--vscode-foreground);
  }
  .spinner {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 3px solid rgba(255,255,255,.2);
    border-top-color: #3b82f6;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .summary {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
    color: var(--vscode-foreground);
    flex-wrap: wrap;
  }
  .summary input, .summary select {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.45));
    height: 26px;
    font: inherit;
  }
  .grid-wrap { flex: 1; min-height: 0; overflow: auto; color: var(--vscode-foreground); }
  .grid-head, .grid-row {
    display: grid;
    align-items: center;
  }
  .grid-head {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--vscode-editor-background);
    font-weight: 600;
  }
  .h, .cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 8px; }
  .h { position: relative; }
  .h { padding-right: 10px; }
  .grip { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 2; }
  .check { display: flex; align-items: center; justify-content: center; padding: 0; overflow: visible; }
  .check input { margin: 0; }
  .grid-group { padding: 3px 8px; font-weight: 600; background: rgba(255,255,255,.04); }
  .grid-row.object { cursor: pointer; }
  .grid-row.selected { background: #094771; }
  .splitter {
    position: relative;
    flex: none;
    height: 14px;
    cursor: ns-resize;
    user-select: none;
    border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
  }
  .splitter:hover { background: rgba(128,128,128,.18); }
  .detail-toggle {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 42px;
    height: 16px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.55));
    border-radius: 8px;
    background: var(--vscode-editor-background);
    z-index: 2;
  }
  .detail { height: 280px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .detail-head { padding: 6px 10px; color: var(--vscode-foreground); }
  .detail-split { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr 14px; }
  .code {
    margin: 0;
    overflow: auto;
    min-width: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 18px;
    color: var(--vscode-editor-foreground);
  }
  .code.empty {
    background: repeating-linear-gradient(-45deg, transparent, transparent 6px, rgba(255,255,255,.04) 6px, rgba(255,255,255,.04) 8px);
  }
  .line { display: flex; min-height: 18px; white-space: pre; }
  .line .no { width: 42px; flex: none; text-align: right; padding-right: 8px; opacity: .45; user-select: none; }
  .line.add { background: rgba(46, 160, 67, .45); }
  .line.del { background: rgba(196, 48, 48, .55); }
  .sql-kw { color: #569cd6; }
  .sql-str { color: #ce9178; }
  .sql-cmt { color: #6a9955; }
  .sql-num { color: #b5cea8; }
  .minimap { position: relative; background: rgba(255,255,255,.04); cursor: pointer; }
  .mark { position: absolute; left: 1px; right: 1px; min-height: 2px; }
  .mark.add { background: #3fb950; }
  .mark.del { background: #f85149; }
  .mark.change { background: linear-gradient(90deg, #3fb950 50%, #f85149 50%); }
  .backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    align-items: center;
    justify-content: center;
  }
  .backdrop.open { display: flex; }
  .dialog {
    width: min(680px, calc(100vw - 48px));
    min-height: 460px;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.45));
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
  }
  .dialog header, .dialog footer {
    display: flex;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
  }
  .dialog header { justify-content: space-between; font-size: 14px; }
  .dialog footer {
    border-bottom: 0;
    border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
    justify-content: flex-end;
    gap: 8px;
    margin-top: auto;
  }
  .dialog .body { padding: 8px 18px 16px; }
  .dialog h2 { font-size: 13px; font-weight: 600; margin: 14px 0 8px; }
  .types { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
  .types label {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    margin: 4px 0;
    width: auto;
  }
  .types input[type="radio"] {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    margin: 0;
  }
  .types svg { flex: 0 0 auto; }
  .pane { display: none; margin-top: 8px; }
  .pane.open { display: block; }
  .field { margin: 10px 0; }
  .field span { display: block; margin-bottom: 4px; }
  select, .pathbox {
    width: 100%;
    box-sizing: border-box;
    height: 28px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,.45));
    font: inherit;
  }
  .pathrow { display: flex; gap: 6px; }
  .pathbox { display: flex; align-items: center; padding: 0 8px; }
  #okBtn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  #cancelBtn {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
</style>
</head>
<body>
  <div class="toolbar">
    <button id="compare" type="button">${icon("compare")} ${t("Compare")}</button>
    <button id="stop" type="button" disabled>${icon("stop")} ${t("Stop")}</button>
    <button id="script" type="button" disabled>${icon("script")} ${t("Generate script")}</button>
    <button id="apply" type="button" disabled title="${t("Apply only the checked objects. Publish sends the whole project.")}">${icon("apply")} ${t("Apply")}</button>
    <button id="optionsBtn" type="button">${icon("options")} ${t("Options")}</button>
    <span class="sep"></span>
    <button id="switchBtn" type="button">${icon("switch")} ${t("Switch direction")}</button>
    <span class="sep"></span>
    <button id="openBtn" type="button">${icon("open")} ${t("Open .scmp")}</button>
    <button id="saveBtn" type="button">${icon("save")} ${t("Save .scmp")}</button>
  </div>
  <div id="options" class="options">
    <h2>${t("Exclude object types")}</h2>
    <label><input id="excludePermissions" type="checkbox"> ${t("Exclude permissions")}</label>
    <label><input id="excludeRoleMembership" type="checkbox"> ${t("Exclude role membership")}</label>
    <label><input id="excludeUsers" type="checkbox"> ${t("Exclude users")}</label>
  </div>
  <div class="ends">
    <div class="end">
      <label for="source">${t("Source")}</label>
      <div class="box">
        <span id="sourceIcon"></span>
        <input id="source" readonly>
        <button id="sourceBrowse" class="icon-btn" type="button" title="${t("Choose source")}">…</button>
      </div>
    </div>
    <button id="switchMid" class="swap" type="button" title="${t("Switch direction")}">${icon("switch")}</button>
    <div class="end">
      <label for="target">${t("Target")}</label>
      <div class="box">
        <span id="targetIcon"></span>
        <input id="target" readonly>
        <button id="targetBrowse" class="icon-btn" type="button" title="${t("Choose target")}">…</button>
      </div>
    </div>
    <button id="compareSide" type="button" disabled>${t("Compare")}</button>
  </div>
  <div id="results"></div>
  <div id="backdrop" class="backdrop">
    <div class="dialog" role="dialog" aria-modal="true">
      <header>
        <span id="dialogTitle">${t("Select target")}</span>
        <button id="closeDialog" type="button" title="${t("Close")}">✕</button>
      </header>
      <div class="body">
        <h2>${t("Type")}</h2>
        <div class="types">
          <label><input type="radio" name="kind" value="database" checked> ${icon("database")} ${t("Database")}</label>
          <label><input type="radio" name="kind" value="dacpac"> ${icon("project")} ${t("Data-tier application file (.dacpac)")}</label>
          <label><input type="radio" name="kind" value="project"> ${icon("project")} ${t("Database project")}</label>
        </div>
        <div id="paneDatabase" class="pane open">
          <h2>${t("Database")}</h2>
          <div class="field">
            <span>${t("Connection")}</span>
            <select id="connectionSelect"></select>
          </div>
          <div class="field">
            <span>${t("Database")}</span>
            <select id="databaseSelect" disabled></select>
          </div>
        </div>
        <div id="paneDacpac" class="pane">
          <h2>${t("File")}</h2>
          <div class="pathrow">
            <div id="dacpacPath" class="pathbox"></div>
            <button id="dacpacBrowse" type="button">…</button>
          </div>
        </div>
        <div id="paneProject" class="pane">
          <h2>${t("Project")}</h2>
          <div class="field">
            <select id="projectSelect"></select>
          </div>
          <button id="projectBrowse" type="button">${t("Browse…")}</button>
        </div>
      </div>
      <footer>
        <button id="cancelBtn" type="button">${t("Cancel")}</button>
        <button id="okBtn" type="button" disabled>${t("OK")}</button>
      </footer>
    </div>
  </div>
  ${webviewL10nScript()}
  <script>
    const vscode = acquireVsCodeApi();
    const boot = ${boot};
    const state = boot.state;
${compareViewScript}
  </script>
</body>
</html>`;
}

function icon(name) {
  const paths = {
    compare: '<path d="M3 4h6v2H3V4zm0 4h6v2H3V8zm8-4h2v10h-2V4zM3 12h6v2H3v-2z"/>',
    stop: '<rect x="4" y="4" width="8" height="8"/>',
    script: '<path d="M4 2h6l3 3v9H4V2zm6 1v2h2"/>',
    apply: '<path d="M5 3l8 5-8 5V3z"/>',
    options: '<circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M13 3l-1.5 1.5M4.5 11.5L3 13"/>',
    switch: '<path d="M2 5h9M8 2l3 3-3 3M14 11H5M8 8l-3 3 3 3"/>',
    open: '<path d="M2 4h4l2 2h6v8H2V4z"/>',
    save: '<path d="M3 2h8l3 3v9H3V2zm2 0v4h6V2M5 9h6v5H5V9z"/>',
    project: '<path d="M3 2h7l3 3v9H3V2z"/>',
    database: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4"/>',
  };
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">${paths[name] || ""}</svg>`;
}

module.exports = { openComparePanel, readSqlConnections, listDatabases };
