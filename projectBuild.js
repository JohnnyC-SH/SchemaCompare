"use strict";

const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");

function findDotnet() {
  const home = process.env.HOME || "";
  const candidates = [
    process.env.DOTNET_ROOT ? path.join(process.env.DOTNET_ROOT, "dotnet") : "",
    path.join(home, ".dotnet", "dotnet"),
    "/usr/local/share/dotnet/dotnet",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "dotnet";
}

function toolDll(extensionPath) {
  return path.join(extensionPath, "tools", "SqlProjectBuild", "publish", "SqlProjectBuild.dll");
}

function compileProject(extensionPath, projectFile, options) {
  const onProgress = options && options.onProgress;
  const onStatus = options && options.onStatus;
  const token = options && options.token;
  const outDir = options && options.outDir;
  const dll = toolDll(extensionPath);
  if (!fs.existsSync(dll)) {
    return Promise.resolve({
      ok: false,
      fatal: "The compiler is missing from the extension.",
      diagnostics: [],
    });
  }

  const args = ["exec", dll, "--project", projectFile];
  if (outDir) {
    args.push("--out", outDir);
  }
  if (options && options.database) {
    args.push("--database", options.database, "--server", options.server || "localhost,1433");
  }
  args.push("--language", (options && options.language) || "en");
  const env = { ...process.env };
  if (options && options.password) {
    env.MSSQL_SA_PASSWORD = options.password;
  }

  return new Promise((resolve) => {
    const child = spawn(findDotnet(), args, { cwd: path.dirname(dll), env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    if (token) {
      token.onCancellationRequested(() => child.kill("SIGTERM"));
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const lines = stderr.split(/\n/);
      stderr = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("progress\t") && onProgress) {
          const parts = line.split("\t");
          onProgress(Number(parts[1]) || 0, Number(parts[2]) || 0);
        } else if (line.startsWith("status\t") && onStatus) {
          onStatus(line.slice("status\t".length));
        }
      }
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        fatal: error.code === "ENOENT" ? "dotnet was not found for the build." : error.message,
        diagnostics: [],
      });
    });
    child.on("close", () => {
      if (token && token.isCancellationRequested) {
        finish({ ok: false, cancelled: true, diagnostics: [] });
        return;
      }
      const parsed = parseResult(stdout);
      if (!parsed) {
        finish({
          ok: false,
          fatal: stderr.trim() || "The compiler did not respond.",
          diagnostics: [],
        });
        return;
      }
      finish(parsed);
    });
  });
}

function parseResult(stdout) {
  const line = stdout.trim().split(/\n/).filter(Boolean).pop();
  if (!line) {
    return null;
  }
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function cleanProject(projectFile) {
  const dir = path.dirname(projectFile);
  const removed = [];
  const errors = [];
  for (const name of ["bin", "obj"]) {
    try {
      if (removeBuildOutput(dir, name)) {
        removed.push(name);
      }
    } catch (error) {
      errors.push(name + ": " + (error.message || "no se pudo quitar"));
    }
  }
  return { removed, errors };
}

function removeBuildOutput(projectDir, name) {
  const root = path.resolve(projectDir);
  const target = path.resolve(projectDir, name);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== prefix + name) {
    return false;
  }
  if (!fs.existsSync(target)) {
    return false;
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return true;
  }
  if (stat.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  }
  fs.unlinkSync(target);
  return true;
}

function readLocalSaPassword() {
  const script = "if [ -z \"$MSSQL_SA_PASSWORD\" ]; then exit 2; fi; printf '%s' \"$MSSQL_SA_PASSWORD\"";
  const bins = ["docker", "/usr/local/bin/docker"];
  const containers = ["sqlserver", "localhost"];
  const attempt = (binIndex, containerIndex) => {
    if (binIndex >= bins.length) {
      return Promise.reject(new Error("docker"));
    }
    if (containerIndex >= containers.length) {
      return attempt(binIndex + 1, 0);
    }
    return execFileText(bins[binIndex], ["exec", containers[containerIndex], "bash", "-lc", script]).catch(() =>
      attempt(binIndex, containerIndex + 1)
    );
  };
  return attempt(0, 0).then((value) => value.replace(/\r?\n$/, ""));
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

module.exports = { compileProject, cleanProject, readLocalSaPassword };
