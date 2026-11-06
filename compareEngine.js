"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { t } = require("./l10n");

const SKIP_DIRECTORIES = new Set(["bin", "obj", "Properties", "node_modules", ".git", ".vs", "Security"]);
const TYPE_FOLDERS = {
  tables: "Table",
  "stored procedures": "Procedure",
  functions: "Function",
  views: "View",
  triggers: "Trigger",
};
const TYPE_LABEL = {
  Table: "Table",
  Procedure: "Procedure",
  Function: "Function",
  View: "View",
  Trigger: "Trigger",
};
const ACTION_LABEL = {
  add: "Add",
  change: "Change",
  delete: "Delete",
};
const catalogCache = {
  modules: new Map(),
  tables: new Map(),
};

async function buildNameDiff(source, target) {
  const sourceObjects = await loadEndpoint(source);
  const targetObjects = await loadEndpoint(target);
  const database = source.kind === "database" ? source.value : target.kind === "database" ? target.value : "";
  catalogCache.modules = database ? await queryModuleDefinitions(database) : new Map();
  catalogCache.tables = database ? await queryTableCatalog(database) : new Map();
  const targetKeys = new Map(targetObjects.map((item) => [objectKey(item), item]));
  const sourceKeys = new Map(sourceObjects.map((item) => [objectKey(item), item]));
  const rows = [];

  for (const item of sourceObjects) {
    const other = targetKeys.get(objectKey(item));
    if (!other) {
      rows.push(makeRow(item, null, "add", rows.length));
    } else if (!sameObject(item, other, source, target)) {
      rows.push(makeRow(item, other, "change", rows.length));
    }
  }
  for (const item of targetObjects) {
    if (!sourceKeys.has(objectKey(item))) {
      rows.push(makeRow(null, item, "delete", rows.length));
    }
  }

  rows.sort((a, b) =>
    a.schema.localeCompare(b.schema, "es", { sensitivity: "base" })
    || a.typeLabel.localeCompare(b.typeLabel, vscode.env.language, { sensitivity: "base" })
    || (a.sourceName || a.targetName).localeCompare(b.sourceName || b.targetName, "es", { sensitivity: "base" })
  );
  rows.forEach((row, index) => {
    row.id = String(index);
  });
  return rows;
}

async function readObjectScript(row, database) {
  const sourceText = await sideScript(row.file, row.sourceName, row, database);
  const targetText = await sideScript(row.targetFile, row.targetName, row, database);
  return { sourceText, targetText };
}

async function sideScript(file, name, row, database) {
  if (file && fs.existsSync(file)) {
    return fs.readFileSync(file, "utf8");
  }
  if (!name || !database || !row.schema || !row.name) {
    return "";
  }
  if (row.type === "Table") {
    const script = scriptTable(row.schema, row.name);
    if (script) {
      return script;
    }
  } else {
    const cached = catalogCache.modules.get(objectKey(row));
    if (cached) {
      return cached;
    }
  }
  return readTargetScript(database, row.schema, row.name, row.type);
}

async function loadEndpoint(endpoint) {
  if (!endpoint) {
    throw new Error(t("Missing source or target"));
  }
  if (endpoint.kind === "project") {
    return collectProjectObjects(endpoint.value);
  }
  if (endpoint.kind === "database") {
    return queryDatabaseObjects(endpoint.value);
  }
  throw new Error(t("That type cannot be compared yet"));
}

function collectProjectObjects(projectFile) {
  const root = path.dirname(projectFile);
  const objects = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return objects;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const schemaDir = path.join(root, entry.name);
    let children = [];
    try {
      children = fs.readdirSync(schemaDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) {
        continue;
      }
      const type = TYPE_FOLDERS[child.name.toLowerCase()];
      if (!type) {
        continue;
      }
      const folder = path.join(schemaDir, child.name);
      let files = [];
      try {
        files = fs.readdirSync(folder);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.toLowerCase().endsWith(".sql")) {
          continue;
        }
        const name = file.replace(/\.sql$/i, "");
        objects.push({
          schema: entry.name,
          name,
          type,
          fullName: `${entry.name}.${name}`,
          file: path.join(folder, file),
        });
      }
    }
  }
  return objects;
}

async function queryDatabaseObjects(database) {
  if (!/^[A-Za-z0-9_]+$/.test(database || "")) {
    throw new Error(t("Invalid database name"));
  }
  const sql = [
    "SET NOCOUNT ON;",
    "SELECT s.name + N'|' + o.name + N'|' + CASE o.type",
    "WHEN 'U' THEN 'Table' WHEN 'P' THEN 'Procedure' WHEN 'PC' THEN 'Procedure'",
    "WHEN 'V' THEN 'View' WHEN 'FN' THEN 'Function' WHEN 'TF' THEN 'Function'",
    "WHEN 'IF' THEN 'Function' WHEN 'TR' THEN 'Trigger' ELSE 'Other' END",
    "FROM sys.objects o",
    "INNER JOIN sys.schemas s ON s.schema_id = o.schema_id",
    "WHERE o.is_ms_shipped = 0 AND o.type IN ('U','P','PC','V','FN','TF','IF','TR');",
  ].join(" ");
  const stdout = await runLocalSql(database, sql, false);
  const objects = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Msg") || /rows affected/i.test(trimmed)) {
      continue;
    }
    const parts = trimmed.split("|");
    if (parts.length < 3 || parts[2] === "Other") {
      continue;
    }
    objects.push({
      schema: parts[0],
      name: parts[1],
      type: parts[2],
      fullName: `${parts[0]}.${parts[1]}`,
      file: "",
    });
  }
  return objects;
}

async function readTargetScript(database, schema, name, type) {
  const objectId = `OBJECT_ID(N'${quoteIdent(schema)}.${quoteIdent(name)}')`;
  const sql = type === "Table"
    ? [
        "SET NOCOUNT ON;",
        "SELECT c.name + N' ' + TYPE_NAME(c.user_type_id) + CASE WHEN c.is_nullable = 1 THEN N' NULL' ELSE N' NOT NULL' END",
        "FROM sys.columns c",
        "INNER JOIN sys.objects o ON o.object_id = c.object_id",
        "INNER JOIN sys.schemas s ON s.schema_id = o.schema_id",
        `WHERE s.name = N'${escapeLiteral(schema)}' AND o.name = N'${escapeLiteral(name)}'`,
        "ORDER BY c.column_id;",
      ].join(" ")
    : `SET NOCOUNT ON; SELECT OBJECT_DEFINITION(${objectId});`;
  const stdout = await runLocalSql(database, sql, true);
  return stdout.replace(/\n\(\d+ rows affected\)\s*$/i, "").trim();
}

function makeRow(source, target, action, index) {
  const item = source || target;
  return {
    id: String(index),
    schema: item.schema,
    name: item.name,
    type: item.type,
    typeLabel: t(TYPE_LABEL[item.type] || item.type),
    action,
    actionLabel: t(ACTION_LABEL[action]),
    sourceName: source ? source.fullName : "",
    targetName: target ? target.fullName : "",
    file: source && source.file ? source.file : "",
    targetFile: target && target.file ? target.file : "",
  };
}

function sameObject(sourceItem, targetItem, source, target) {
  const project = source.kind === "project" ? sourceItem : target.kind === "project" ? targetItem : null;
  if (!project || !project.file || !fs.existsSync(project.file)) {
    return true;
  }
  if (project.type === "Table") {
    return tableMatches(project);
  }
  const dbText = catalogCache.modules.get(objectKey(project));
  if (dbText == null) {
    return true;
  }
  return normalizeSql(fs.readFileSync(project.file, "utf8")) === normalizeSql(dbText);
}

function tableMatches(project) {
  const fileSig = signatureFromFile(fs.readFileSync(project.file, "utf8"));
  const dbSig = signatureFromCatalog(project.schema, project.name);
  if (!fileSig || !dbSig) {
    return true;
  }
  return fileSig === dbSig;
}

function normalizeSql(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\bgo\b/gi, " ")
    .replace(/\bset\s+(ansi_nulls|quoted_identifier|ansi_padding|ansi_warnings|concat_null_yields_null)\s+(on|off)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function signatureFromFile(text) {
  const columns = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*\[([^\]]+)\]\s+([A-Za-z][A-Za-z0-9_]*)\s*(?:\(\s*([^)]*?)\s*\))?/);
    if (!match) {
      continue;
    }
    const type = match[2].toLowerCase();
    if (["constraint", "primary", "unique", "foreign", "index", "key", "on", "with"].includes(type)) {
      continue;
    }
    const args = normalizeTypeArgs(type, (match[3] || "").replace(/\s+/g, "").toLowerCase());
    const nullable = /\bnot\s+null\b/i.test(line) ? "0" : /\bnull\b/i.test(line) ? "1" : "0";
    const identity = line.match(/\bidentity\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i);
    columns.push([match[1].toLowerCase(), type, args, nullable, identity ? "1" : "0", identity ? String(Number(identity[1])) : "", identity ? String(Number(identity[2])) : ""].join("|"));
  }
  if (!columns.length) {
    return "";
  }
  const pk = primaryKeyFromFile(text);
  return columns.join("\n") + (pk ? `\npk|${pk}` : "");
}

function primaryKeyFromFile(text) {
  const match = String(text || "").match(/\bprimary\s+key\b[^(\n]*\(([^)]*)\)/i);
  if (!match) {
    return "";
  }
  const names = [];
  for (const part of match[1].split(",")) {
    const name = part.match(/\[([^\]]+)\]/);
    if (name) {
      names.push(name[1].toLowerCase());
    }
  }
  return names.join(",");
}

function signatureFromCatalog(schema, name) {
  const table = catalogCache.tables.get(tableKey(schema, name));
  if (!table || !table.columns.length) {
    return "";
  }
  const columns = table.columns.map((column) => [
    column.name.toLowerCase(),
    column.type.toLowerCase(),
    normalizeTypeArgs(column.type.toLowerCase(), typeArg(column)),
    column.nullable ? "1" : "0",
    column.identity ? "1" : "0",
    column.identity ? String(Number(column.seed)) : "",
    column.identity ? String(Number(column.increment)) : "",
  ].join("|"));
  const pk = table.pk.map((item) => item.toLowerCase()).join(",");
  return columns.join("\n") + (pk ? `\npk|${pk}` : "");
}

function normalizeTypeArgs(type, args) {
  if (["datetime2", "datetimeoffset", "time"].includes(type) && (args === "" || args === "7")) {
    return "";
  }
  if (type === "float" && (args === "" || args === "53")) {
    return "";
  }
  return args;
}

function typeArg(column) {
  const type = column.type.toLowerCase();
  const length = Number(column.maxLength);
  if (["varchar", "char", "varbinary", "binary"].includes(type)) {
    return length < 0 ? "max" : String(length);
  }
  if (["nvarchar", "nchar"].includes(type)) {
    return length < 0 ? "max" : String(Math.floor(length / 2));
  }
  if (["decimal", "numeric"].includes(type)) {
    return `${Number(column.precision)},${Number(column.scale)}`;
  }
  if (["datetime2", "datetimeoffset", "time"].includes(type)) {
    return String(Number(column.scale));
  }
  return "";
}

function scriptTable(schema, name) {
  const table = catalogCache.tables.get(tableKey(schema, name));
  if (!table || !table.columns.length) {
    return "";
  }
  const lines = table.columns.map((column) => {
    const type = column.type.toLowerCase();
    const args = typeArg(column);
    let line = `    [${column.name}] ${column.type}${args ? `(${args})` : ""}`;
    if (column.identity) {
      line += ` IDENTITY(${column.seed}, ${column.increment})`;
    }
    line += column.nullable ? " NULL" : " NOT NULL";
    return line;
  });
  if (table.pk.length) {
    lines.push(`    PRIMARY KEY (${table.pk.map((item) => `[${item}]`).join(", ")})`);
  }
  return `CREATE TABLE [${schema}].[${name}] (\n${lines.join(",\n")}\n);`;
}

function tableKey(schema, name) {
  return `${String(schema).toLowerCase()}|${String(name).toLowerCase()}`;
}

async function queryModuleDefinitions(database) {
  const sql = [
    "SET NOCOUNT ON;",
    "WITH defs AS (",
    "SELECT s.name AS sch, o.name AS nm,",
    "CASE o.type WHEN 'P' THEN 'Procedure' WHEN 'PC' THEN 'Procedure' WHEN 'V' THEN 'View'",
    "WHEN 'FN' THEN 'Function' WHEN 'TF' THEN 'Function' WHEN 'IF' THEN 'Function' ELSE 'Trigger' END AS typ,",
    "REPLACE(REPLACE(REPLACE(ISNULL(OBJECT_DEFINITION(o.object_id), N''), N'|', NCHAR(2)), CHAR(13), N''), CHAR(10), NCHAR(1)) AS def",
    "FROM sys.objects o INNER JOIN sys.schemas s ON s.schema_id = o.schema_id",
    "WHERE o.is_ms_shipped = 0 AND o.type IN ('P','PC','V','FN','TF','IF','TR')",
    "), nums AS (",
    "SELECT TOP (12) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS n FROM sys.all_objects",
    ")",
    "SELECT N'~' + d.sch + N'|' + d.nm + N'|' + d.typ + N'|' + CAST(n.n AS nvarchar(10)) + N'|'",
    "+ CAST(LEN(SUBSTRING(d.def, n.n * 20000 + 1, 20000)) AS nvarchar(10)) + N'|'",
    "+ SUBSTRING(d.def, n.n * 20000 + 1, 20000)",
    "FROM defs d INNER JOIN nums n ON n.n * 20000 < CASE WHEN LEN(d.def) = 0 THEN 1 ELSE LEN(d.def) END;",
  ].join(" ");
  const stdout = await runLocalSql(database, sql, true);
  const groups = new Map();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("~")) {
      continue;
    }
    const parts = line.slice(1).split("|");
    if (parts.length < 6) {
      continue;
    }
    const key = `${parts[2]}|${parts[0].toLowerCase()}|${parts[1].toLowerCase()}`;
    const index = Number(parts[3]);
    const length = Number(parts[4]);
    let payload = parts.slice(5).join("|");
    if (Number.isFinite(length) && length >= 0 && payload.length > length) {
      payload = payload.slice(0, length);
    }
    payload = payload.replace(/\u0001/g, "\n").replace(/\u0002/g, "|");
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)[index] = payload;
  }
  const modules = new Map();
  for (const [key, chunks] of groups) {
    modules.set(key, chunks.join(""));
  }
  return modules;
}

async function queryTableCatalog(database) {
  const columnsSql = [
    "SET NOCOUNT ON;",
    "SELECT s.name + N'|' + o.name + N'|' + CAST(c.column_id AS nvarchar(10)) + N'|' + c.name + N'|'",
    "+ TYPE_NAME(c.user_type_id) + N'|' + CAST(c.max_length AS nvarchar(10)) + N'|'",
    "+ CAST(c.precision AS nvarchar(10)) + N'|' + CAST(c.scale AS nvarchar(10)) + N'|'",
    "+ CAST(c.is_nullable AS nvarchar(1)) + N'|' + CAST(c.is_identity AS nvarchar(1)) + N'|'",
    "+ ISNULL(CAST(ic.seed_value AS nvarchar(40)), N'') + N'|' + ISNULL(CAST(ic.increment_value AS nvarchar(40)), N'')",
    "FROM sys.columns c",
    "INNER JOIN sys.objects o ON o.object_id = c.object_id",
    "INNER JOIN sys.schemas s ON s.schema_id = o.schema_id",
    "LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id",
    "WHERE o.is_ms_shipped = 0 AND o.type = 'U'",
    "ORDER BY s.name, o.name, c.column_id;",
  ].join(" ");
  const pkSql = [
    "SET NOCOUNT ON;",
    "SELECT s.name + N'|' + o.name + N'|' + CAST(ic.key_ordinal AS nvarchar(10)) + N'|' + c.name",
    "FROM sys.indexes i",
    "INNER JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id",
    "INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id",
    "INNER JOIN sys.objects o ON o.object_id = i.object_id",
    "INNER JOIN sys.schemas s ON s.schema_id = o.schema_id",
    "WHERE i.is_primary_key = 1 AND o.type = 'U' AND ic.is_included_column = 0",
    "ORDER BY s.name, o.name, ic.key_ordinal;",
  ].join(" ");
  const tables = new Map();
  const ensure = (schema, name) => {
    const key = tableKey(schema, name);
    if (!tables.has(key)) {
      tables.set(key, { schema, name, columns: [], pk: [] });
    }
    return tables.get(key);
  };
  for (const line of (await runLocalSql(database, columnsSql, false)).split(/\r?\n/)) {
    const parts = line.trim().split("|");
    if (parts.length < 12 || /rows affected/i.test(line)) {
      continue;
    }
    const table = ensure(parts[0], parts[1]);
    table.columns.push({
      name: parts[3],
      type: parts[4],
      maxLength: Number(parts[5]),
      precision: Number(parts[6]),
      scale: Number(parts[7]),
      nullable: parts[8] === "1",
      identity: parts[9] === "1",
      seed: parts[10],
      increment: parts[11],
    });
  }
  for (const line of (await runLocalSql(database, pkSql, false)).split(/\r?\n/)) {
    const parts = line.trim().split("|");
    if (parts.length < 4 || /rows affected/i.test(line)) {
      continue;
    }
    ensure(parts[0], parts[1]).pk.push(parts[3]);
  }
  return tables;
}

function objectKey(item) {
  return `${item.type}|${item.schema.toLowerCase()}|${item.name.toLowerCase()}`;
}

function quoteIdent(name) {
  if (!/^[\w@#$]+$/.test(name)) {
    throw new Error(t("Invalid object name"));
  }
  return `[${name.replace(/]/g, "]]")}]`;
}

function escapeLiteral(name) {
  return String(name).replace(/'/g, "''");
}

function runLocalSql(database, sql, wide, abortOnError) {
  const bins = ["docker", "/usr/local/bin/docker"];
  const containers = ["sqlserver", "localhost"];
  const argsFor = (bin, container) => [
    "exec",
    "-e",
    `MSSQL_QUERY=${sql}`,
    container,
    "bash",
    "-lc",
    [
      "SQLCMD=/opt/mssql-tools18/bin/sqlcmd",
      "if [ ! -x \"$SQLCMD\" ]; then SQLCMD=/opt/mssql-tools/bin/sqlcmd; fi",
      "if [ -z \"$MSSQL_SA_PASSWORD\" ] || [ ! -x \"$SQLCMD\" ]; then exit 2; fi",
      `"$SQLCMD" -C ${abortOnError ? "-b " : ""}-S localhost -U sa -P "$MSSQL_SA_PASSWORD" -d ${database} ${wide ? "-y 0 -w 65535" : "-h -1 -W"} -Q "$MSSQL_QUERY"`,
    ].join("; "),
  ];

  const attempt = (binIndex, containerIndex, lastDetail) => {
    if (binIndex >= bins.length) {
      return Promise.reject(lastDetail || t("Could not read the local database"));
    }
    if (containerIndex >= containers.length) {
      return attempt(binIndex + 1, 0, lastDetail);
    }
    return execFileText(bins[binIndex], argsFor(bins[binIndex], containers[containerIndex])).catch((error) =>
      attempt(binIndex, containerIndex + 1, error)
    );
  };
  return attempt(0, 0, null).catch((error) => {
    throw new Error(sqlFailureText(error));
  });
}

function sqlFailureText(error) {
  const stdout = String((error && error.stdout) || "");
  const stderr = String((error && error.stderr) || "");
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const index = lines.findIndex((line) => /^Msg\s+\d+/i.test(line));
  if (index >= 0) {
    const detail = lines[index + 1] && !/^Msg\s+\d+/i.test(lines[index + 1]) ? lines[index + 1] : "";
    return `${lines[index]}${detail ? ". " + detail : ""}`.replace(/\s+/g, " ").slice(0, 240);
  }
  return t("The engine rejected the script.");
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function executeLocalSql(database, sql) {
  if (!/^[A-Za-z0-9_]+$/.test(database || "")) {
    return Promise.reject(new Error(t("Invalid database name")));
  }
  return runLocalSql(database, sql, true, true);
}

module.exports = { buildNameDiff, readObjectScript, executeLocalSql };
