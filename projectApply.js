"use strict";

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { t } = require("./l10n");
const { executeLocalSql, readObjectScript } = require("./compareEngine");

const TYPE_DIR = {
  Procedure: "Stored Procedures",
  Function: "Functions",
  View: "Views",
  Trigger: "Triggers",
};

function typeName(type) {
  return t({
    Table: "Table",
    Procedure: "Procedure",
    Function: "Function",
    View: "View",
    Trigger: "Trigger",
  }[type] || type);
}

function actionName(action) {
  return t({ add: "Add", change: "Change", delete: "Delete" }[action] || action);
}

async function applySelectionToProject(source, target, rows) {
  if (!source || source.kind !== "database" || !target || target.kind !== "project") {
    throw new Error(t("Apply only writes to the project when the source is the database"));
  }
  const projectFile = target.value;
  const root = path.dirname(projectFile);
  if (!fs.existsSync(projectFile)) {
    throw new Error(t("Could not find the project"));
  }
  const selected = Array.isArray(rows) ? rows : [];
  const tables = selected.filter((row) => row.type === "Table");
  const workable = selected.filter((row) => TYPE_DIR[row.type]);
  if (!workable.length) {
    return {
      written: 0,
      removed: 0,
      skippedTables: tables.length,
      empty: true,
    };
  }
  const tableNote = tables.length ? " " + t("{0} tables are left out.", tables.length) : "";
  const choice = await vscode.window.showWarningMessage(
    t("Write {0} objects into the project.", workable.length) + tableNote,
    { modal: true },
    t("Apply")
  );
  if (choice !== t("Apply")) {
    return { cancelled: true, written: 0, removed: 0, skippedTables: tables.length };
  }

  const added = [];
  const removed = [];
  let written = 0;
  for (const row of workable) {
    if (!safePart(row.schema) || !safePart(row.name)) {
      continue;
    }
    if (row.action === "delete") {
      const file = row.targetFile;
      if (!file || !isInside(root, file)) {
        continue;
      }
      await deleteProjectFile(file);
      removed.push(includePath(root, file));
      continue;
    }
    const script = await readObjectScript(row, source.value);
    const text = String(script.sourceText || "").replace(/\s+$/, "") + "\n";
    if (!script.sourceText || !script.sourceText.trim()) {
      continue;
    }
    const file = row.action === "add" ? newFilePath(root, row) : row.targetFile;
    if (!file || !isInside(root, file)) {
      continue;
    }
    await writeProjectFile(file, text);
    if (row.action === "add") {
      added.push(includePath(root, file));
    }
    written += 1;
  }
  if (added.length || removed.length) {
    const current = fs.readFileSync(projectFile, "utf8");
    await writeProjectFile(projectFile, updateSqlProjText(current, added, removed));
  }
  return { written, removed: removed.length, skippedTables: tables.length, cancelled: false };
}

async function applySelectionToDatabase(source, target, rows, onProgress) {
  if (!source || source.kind !== "project" || !target || target.kind !== "database") {
    throw new Error(t("To change the database, the source must be the project and the target the database"));
  }
  const database = target.value;
  const selected = Array.isArray(rows) ? rows : [];
  const workable = selected.filter((row) => (TYPE_DIR[row.type] || row.type === "Table") && safePart(row.schema) && safePart(row.name));
  if (!workable.length) {
    return { applied: 0, skippedTables: 0, empty: true, failures: [] };
  }
  const shown = workable.slice(0, 8).map((row) => `${typeName(row.type)} ${row.sourceName || row.targetName} (${actionName(row.action)})`);
  const more = workable.length > shown.length ? "\n" + t("… and {0} more.", workable.length - shown.length) : "";
  const destructive = workable.filter((row) => row.type === "Table" && (row.action === "delete" || row.action === "change"));
  const dataNote = destructive.length
    ? "\n" + t("{0} tables are dropped or recreated. Their data is lost.", destructive.length)
    : "";
  const choice = await vscode.window.showWarningMessage(
    t("Apply {0} objects to database {1}. Only the checked ones. The database will change.", workable.length, database) + dataNote + "\n" + shown.join("\n") + more,
    { modal: true },
    t("Apply")
  );
  if (choice !== t("Apply")) {
    return { cancelled: true, applied: 0, skippedTables: 0, failures: [] };
  }
  const ordered = workable.slice().sort((a, b) => applyRank(a) - applyRank(b));
  const failures = [];
  let applied = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const row = ordered[index];
    const name = row.sourceName || row.targetName;
    if (onProgress) onProgress(index + 1, ordered.length, name);
    try {
      await executeLocalSql(database, await statementFor(row, database));
      applied += 1;
    } catch (error) {
      failures.push({ name, reason: error.message || t("The engine rejected the script.") });
    }
  }
  return { applied, skippedTables: 0, failures, cancelled: false, empty: false };
}

function applyRank(row) {
  if (row.action === "delete" && row.type !== "Table") return 0;
  if (row.type === "Table" && (row.action === "delete" || row.action === "change")) return 1;
  if (row.type === "Table") return 2;
  return 3;
}

async function statementFor(row, database) {
  if (row.type !== "Table") {
    return row.action === "delete" ? dropStatement(row) : toCreateOrAlter(await projectScript(row, database));
  }
  if (row.action === "delete") {
    return dropStatement(row);
  }
  const script = await projectScript(row, database);
  if (row.action !== "change") {
    return script;
  }
  return `SET XACT_ABORT ON;\nBEGIN TRAN;\n${dropStatement(row)}\n${script}\nCOMMIT TRAN;`;
}

async function projectScript(row, database) {
  const script = await readObjectScript(row, database);
  const text = String(script.sourceText || "").trim();
  if (!text) {
    throw new Error("el proyecto no tiene script");
  }
  return text;
}

function toCreateOrAlter(sql) {
  return String(sql).replace(
    /\bcreate\s+(?:or\s+alter\s+)?(proc|procedure|function|view|trigger)\b/i,
    "CREATE OR ALTER $1"
  );
}

function dropStatement(row) {
  const kind = { Procedure: "PROCEDURE", Function: "FUNCTION", View: "VIEW", Trigger: "TRIGGER", Table: "TABLE" }[row.type];
  return `DROP ${kind} IF EXISTS ${quoteIdent(row.schema)}.${quoteIdent(row.name)};`;
}

function quoteIdent(name) {
  if (!/^[\w@#$]+$/.test(name)) {
    throw new Error(t("Invalid object name"));
  }
  return `[${name.replace(/]/g, "]]")}]`;
}

function updateSqlProjText(text, addIncludes, removeIncludes) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let next = String(text || "");
  for (const include of removeIncludes) {
    const pattern = new RegExp(
      `^[ \\t]*<Build Include="${escapeRegExp(include)}"\\s*/>[ \\t]*\\r?\\n`,
      "gim"
    );
    next = next.replace(pattern, "");
  }
  const missing = addIncludes.filter((include) => !includesBuild(next, include));
  if (!missing.length) {
    return next;
  }
  const block = [
    "  <ItemGroup>",
    ...missing.map((include) => `    <Build Include="${include}" />`),
    "  </ItemGroup>",
  ].join(newline);
  if (/<\/Project>\s*$/i.test(next)) {
    return next.replace(/<\/Project>\s*$/i, `${block}${newline}</Project>${newline}`);
  }
  return `${next}${newline}${block}${newline}`;
}

function includesBuild(text, include) {
  return text.toLowerCase().includes(`include="${include.toLowerCase()}"`);
}

function newFilePath(root, row) {
  return path.join(root, row.schema, TYPE_DIR[row.type], `${row.name}.sql`);
}

function includePath(root, file) {
  return path.relative(root, file).split(path.sep).join("\\");
}

function isInside(root, file) {
  const base = path.resolve(root) + path.sep;
  const target = path.resolve(file);
  return target.startsWith(base);
}

function safePart(value) {
  return typeof value === "string" && value.length > 0 && !/[\\/]/.test(value) && value !== "." && value !== "..";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeProjectFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const uri = vscode.Uri.file(file);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, text, "utf8");
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.getText().replace(/\r\n/g, "\n") === text.replace(/\r\n/g, "\n")) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    text
  );
  if (!await vscode.workspace.applyEdit(edit)) {
    throw new Error(t("Could not write {0}", path.basename(file)));
  }
  if (document.isDirty) {
    await document.save();
  }
}

async function deleteProjectFile(file) {
  const uri = vscode.Uri.file(file);
  const edit = new vscode.WorkspaceEdit();
  edit.deleteFile(uri, { ignoreIfNotExists: true });
  await vscode.workspace.applyEdit(edit);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

module.exports = { applySelectionToProject, applySelectionToDatabase, updateSqlProjText, toCreateOrAlter };
