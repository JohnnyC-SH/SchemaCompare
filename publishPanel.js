"use strict";

const vscode = require("vscode");
const { t, webviewL10nScript } = require("./l10n");

function createPublishPanel(context, projectFile, projectName) {
  const panel = vscode.window.createWebviewPanel(
    "johnnySchemaCompare.publish",
    t("Publish {0}", projectName),
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "Logo", "Comparar128.png");
  panel.webview.html = publishHtml(projectName, projectFile);
  return panel;
}

function publishHtml(projectName, projectFile) {
  const title = JSON.stringify(projectName);
  const file = JSON.stringify(projectFile);
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body {
    margin: 0;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    background: var(--vscode-editor-background);
  }
  .dialog {
    width: min(520px, calc(100vw - 32px));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.45));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    box-shadow: 0 8px 28px rgba(0,0,0,.35);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
  }
  h1 { margin: 0; font-size: 13px; font-weight: 600; }
  .body { padding: 14px 16px 16px; }
  .project { margin: 0 0 12px; color: var(--vscode-descriptionForeground); word-break: break-all; }
  label { display: block; margin: 10px 0 4px; }
  select, button {
    font: inherit;
    color: var(--vscode-foreground);
  }
  select {
    width: 100%;
    height: 28px;
    box-sizing: border-box;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,.45));
  }
  .note { margin: 14px 0 0; line-height: 1.4; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  button { height: 28px; padding: 0 12px; border: 0; cursor: pointer; }
  #cancel {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  #go {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  #go:disabled { opacity: .55; cursor: default; }
  #status { min-height: 1.2em; margin: 10px 0 0; }
</style>
</head>
<body>
  <div class="dialog" role="dialog" aria-modal="true">
    <header><h1>${t("Publish")}</h1></header>
    <div class="body">
      <p class="project" id="project"></p>
      <label for="connection">${t("Connection")}</label>
      <select id="connection"></select>
      <label for="database">${t("Database")}</label>
      <select id="database" disabled></select>
      <p class="note">${t("The whole project is published. Users, permissions, and role membership are not included. Objects that exist only in the database are not dropped. If a change would delete data, publishing stops.")}</p>
      <p id="status"></p>
      <div class="actions">
        <button id="cancel" type="button">${t("Cancel")}</button>
        <button id="go" type="button" disabled>${t("Publish")}</button>
      </div>
    </div>
  </div>
  ${webviewL10nScript()}
  <script>
    const vscode = acquireVsCodeApi();
    const projectName = ${title};
    const projectFile = ${file};
    const connection = document.getElementById("connection");
    const database = document.getElementById("database");
    const go = document.getElementById("go");
    const status = document.getElementById("status");
    document.getElementById("project").textContent = projectName + " — " + projectFile;

    function fill(select, items, placeholder) {
      select.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = placeholder;
      select.appendChild(empty);
      for (const item of items) {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        select.appendChild(option);
      }
    }

    function refreshGo() {
      go.disabled = !connection.value || !database.value;
    }

    connection.addEventListener("change", () => {
      fill(database, [], connection.value ? t("Reading…") : t("Select"));
      database.disabled = true;
      refreshGo();
      if (connection.value) {
        vscode.postMessage({ type: "listDatabases", connectionId: connection.value });
      }
    });
    database.addEventListener("change", refreshGo);
    document.getElementById("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
    go.addEventListener("click", () => {
      go.disabled = true;
      status.textContent = t("Publishing…");
      vscode.postMessage({
        type: "publish",
        connectionId: connection.value,
        database: database.value
      });
    });

    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "connections") {
        fill(connection, message.connections.map((item) => ({
          value: item.id || item.profileName,
          label: item.profileName
        })), t("Select"));
        if (message.connections.length === 1) {
          connection.value = message.connections[0].id || message.connections[0].profileName;
          connection.dispatchEvent(new Event("change"));
        }
      }
      if (message.type === "databases") {
        fill(database, message.databases.map((name) => ({ value: name, label: name })), t("Select"));
        database.disabled = message.databases.length === 0;
        if (message.databases.length === 1) database.value = message.databases[0];
        refreshGo();
      }
      if (message.type === "done") {
        status.textContent = message.text || "";
        refreshGo();
      }
    });
    vscode.postMessage({ type: "refreshConnections" });
  </script>
</body>
</html>`;
}

module.exports = { createPublishPanel };
