using System.Globalization;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.SqlServer.Dac;
using Microsoft.SqlServer.Dac.Model;
using Microsoft.SqlServer.TransactSql.ScriptDom;

var language = Arg(args, "--language") ?? "";
Ui.Spanish = language.StartsWith("es", StringComparison.OrdinalIgnoreCase);
var culture = CultureInfo.GetCultureInfo(Ui.Spanish ? "es" : "en");
CultureInfo.CurrentCulture = culture;
CultureInfo.CurrentUICulture = culture;

var projectPath = Arg(args, "--project");
var outDir = Arg(args, "--out");
if (string.IsNullOrWhiteSpace(projectPath) || !File.Exists(projectPath))
{
    Fail(Ui.Text("Missing the .sqlproj.", "Falta el .sqlproj."));
}

try
{
    var project = ReadProject(Path.GetFullPath(projectPath!));
    var diagnostics = new List<Diagnostic>();
    var version = ServerVersion(project.Dsp);
    var modelOptions = new TSqlModelOptions
    {
        AnsiNullsOn = true,
        QuotedIdentifierOn = true,
        AnsiPaddingOn = true,
        AnsiWarningsOn = true,
        ConcatNullYieldsNull = true
    };
    if (!string.IsNullOrWhiteSpace(project.Collation))
    {
        modelOptions.Collation = project.Collation;
    }

    using var model = new TSqlModel(version, modelOptions);
    var objectOptions = new TSqlObjectOptions { AnsiNulls = true, QuotedIdentifier = true };
    var index = 0;
    foreach (var file in project.Files)
    {
        index++;
        if (index % 25 == 0 || index == project.Files.Count)
        {
            Console.Error.WriteLine($"progress\t{index}\t{project.Files.Count}");
        }

        if (!File.Exists(file))
        {
            diagnostics.Add(new Diagnostic("error", file, 1, 1, Ui.Text("The project file is missing.", "No está el archivo del proyecto.")));
            continue;
        }

        var script = File.ReadAllText(file);
        foreach (var error in ParseErrors(script, version))
        {
            var severity = IsParserWarning(error.Message) ? "warning" : "error";
            var text = error.Number > 0 ? "SQL" + error.Number + ": " + error.Message : error.Message;
            diagnostics.Add(new Diagnostic(severity, file, Math.Max(1, error.Line), Math.Max(1, error.Column), text));
        }

        try
        {
            model.AddOrUpdateObjects(script, file, objectOptions);
        }
        catch (DacModelException ex)
        {
            var added = false;
            foreach (var message in ex.Messages)
            {
                if (AddFresh(diagnostics, ReadMessage(message, ""), file))
                {
                    added = true;
                }
            }
            if (!added && !AlreadyReported(diagnostics, ex.Message))
            {
                diagnostics.Add(new Diagnostic("error", file, 1, 1, ex.Message));
            }
        }
        catch (Exception ex)
        {
            diagnostics.Add(new Diagnostic("error", file, 1, 1, ex.Message));
        }
    }

    foreach (var error in model.GetModelErrors())
    {
        var (errorFile, line, column) = Locate(error);
        var modelMessage = error.Message ?? Ui.Text("Model error", "Error de modelo");
        var modelSeverity = IsParserWarning(modelMessage) ? "warning" : "error";
        AddFresh(diagnostics, new Diagnostic(modelSeverity, errorFile, line, column, modelMessage), "");
    }

    foreach (var message in model.Validate())
    {
        AddFresh(diagnostics, ReadMessage(message, ""), "");
    }

    var sources = ObjectSources(model);
    diagnostics = diagnostics
        .Distinct()
        .Select(item => Place(item, sources))
        .Select(item => project.TreatWarningsAsErrors && item.Severity == "warning"
            ? item with { Severity = "error" }
            : item)
        .ToList();

    var errors = diagnostics.Where(item => item.Severity == "error").ToList();
    string dacpac = "";
    if (errors.Count == 0)
    {
        var folder = string.IsNullOrWhiteSpace(outDir)
            ? Path.Combine(project.Directory, "bin", "Debug")
            : Path.GetFullPath(outDir);
        Directory.CreateDirectory(folder);
        dacpac = Path.Combine(folder, project.AssemblyName + ".dacpac");
        if (File.Exists(dacpac))
        {
            File.Delete(dacpac);
        }

        try
        {
            DacPackageExtensions.BuildPackage(
                dacpac,
                model,
                new PackageMetadata { Name = project.AssemblyName, Version = "1.0.0.0" });
        }
        catch (Exception ex)
        {
            if (File.Exists(dacpac))
            {
                File.Delete(dacpac);
            }
            dacpac = "";
            foreach (var message in ValidationMessages(ex))
            {
                diagnostics.Add(Place(message, sources));
            }
            if (diagnostics.All(item => item.Severity != "error"))
            {
                diagnostics.Add(new Diagnostic("error", projectPath ?? "", 1, 1, ex.Message));
            }
        }
    }

    var database = Arg(args, "--database");
    var published = false;
    if (diagnostics.All(item => item.Severity != "error") && !string.IsNullOrWhiteSpace(database) && !string.IsNullOrWhiteSpace(dacpac))
    {
        published = PublishDatabase(dacpac, Arg(args, "--server") ?? "localhost,1433", database, diagnostics);
    }

    var errorCount = diagnostics.Count(item => item.Severity == "error");
    Write(new Result(errorCount == 0, dacpac, diagnostics, published));
    Environment.Exit(errorCount == 0 ? 0 : 1);
}
catch (Exception ex)
{
    Fail(ex.Message);
}

static void Write(Result result)
{
    Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    }));
}

static void Fail(string message)
{
    Write(new Result(false, "", new[] { new Diagnostic("error", "", 1, 1, message) }));
    Environment.Exit(2);
}

static string? Arg(string[] args, string name)
{
    for (var i = 0; i < args.Length - 1; i++)
    {
        if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
        {
            return args[i + 1];
        }
    }
    return null;
}

static Project ReadProject(string projectPath)
{
    var document = XDocument.Load(projectPath);
    string Value(string name) => document
        .Descendants()
        .FirstOrDefault(element => element.Name.LocalName == name && !string.IsNullOrWhiteSpace(element.Value))
        ?.Value.Trim() ?? "";

    var directory = Path.GetDirectoryName(projectPath) ?? "";
    var root = Path.GetFullPath(directory);
    var files = new List<string>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var item in document.Descendants().Where(element => element.Name.LocalName == "Build"))
    {
        var include = item.Attribute("Include")?.Value;
        if (string.IsNullOrWhiteSpace(include))
        {
            continue;
        }

        var relative = include.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar);
        var full = Path.GetFullPath(Path.Combine(root, relative));
        var prefix = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && !string.Equals(full, root, StringComparison.OrdinalIgnoreCase))
        {
            continue;
        }
        if (seen.Add(full))
        {
            files.Add(full);
        }
    }

    var assembly = Value("AssemblyName");
    if (string.IsNullOrWhiteSpace(assembly))
    {
        assembly = Path.GetFileNameWithoutExtension(projectPath);
    }
    foreach (var invalid in Path.GetInvalidFileNameChars())
    {
        assembly = assembly.Replace(invalid, '_');
    }

    var treatWarnings = Value("TreatWarningsAsErrors").Equals("true", StringComparison.OrdinalIgnoreCase);
    return new Project(directory, Value("DSP"), Value("DefaultCollation"), assembly, treatWarnings, files);
}

static SqlServerVersion ServerVersion(string dsp)
{
    if (dsp.Contains("SqlAzure", StringComparison.OrdinalIgnoreCase))
    {
        return SqlServerVersion.SqlAzure;
    }
    if (dsp.Contains("SqlDw", StringComparison.OrdinalIgnoreCase))
    {
        return SqlServerVersion.SqlDw;
    }

    var digits = new string(dsp.Where(char.IsDigit).ToArray());
    return digits switch
    {
        "160" => SqlServerVersion.Sql160,
        "150" => SqlServerVersion.Sql150,
        "140" => SqlServerVersion.Sql140,
        "130" => SqlServerVersion.Sql130,
        "120" => SqlServerVersion.Sql120,
        "110" => SqlServerVersion.Sql110,
        "100" => SqlServerVersion.Sql100,
        _ => SqlServerVersion.Sql160
    };
}

static IEnumerable<ParseError> ParseErrors(string script, SqlServerVersion version)
{
    var parser = Parser(version);
    using var reader = new StringReader(script);
    parser.Parse(reader, out var errors);
    return errors ?? Array.Empty<ParseError>();
}

static TSqlParser Parser(SqlServerVersion version)
{
    return version switch
    {
        SqlServerVersion.Sql100 => new TSql100Parser(true),
        SqlServerVersion.Sql110 => new TSql110Parser(true),
        SqlServerVersion.Sql120 => new TSql120Parser(true),
        SqlServerVersion.Sql130 => new TSql130Parser(true),
        SqlServerVersion.Sql140 => new TSql140Parser(true),
        SqlServerVersion.Sql150 => new TSql150Parser(true),
        _ => new TSql160Parser(true)
    };
}

static bool AddFresh(List<Diagnostic> diagnostics, Diagnostic? diagnostic, string fallbackFile)
{
    if (diagnostic == null || AlreadyReported(diagnostics, diagnostic.Message))
    {
        return false;
    }
    if (string.IsNullOrEmpty(diagnostic.File) && !string.IsNullOrEmpty(fallbackFile))
    {
        diagnostic = diagnostic with { File = fallbackFile };
    }
    diagnostics.Add(diagnostic);
    return true;
}

static bool AlreadyReported(List<Diagnostic> diagnostics, string message)
{
    var core = Core(message);
    if (core.Length == 0)
    {
        return false;
    }
    return diagnostics.Any(item =>
    {
        var other = Core(item.Message);
        return other.Equals(core, StringComparison.OrdinalIgnoreCase)
            || other.Contains(core, StringComparison.OrdinalIgnoreCase)
            || core.Contains(other, StringComparison.OrdinalIgnoreCase);
    });
}

static string Core(string message)
{
    var index = message.IndexOf(':');
    return index >= 0 && index < 16 ? message[(index + 1)..].Trim() : message.Trim();
}

static List<ObjectSource> ObjectSources(TSqlModel model)
{
    var sources = new List<ObjectSource>();
    foreach (var obj in model.GetObjects(DacQueryScopes.UserDefined))
    {
        var info = obj.GetSourceInformation();
        if (info == null || string.IsNullOrEmpty(info.SourceName) || obj.Name == null || obj.Name.Parts.Count == 0)
        {
            continue;
        }
        var name = string.Join(".", obj.Name.Parts.Select(part => "[" + part.Replace("]", "]]") + "]"));
        sources.Add(new ObjectSource(
            name,
            info.SourceName,
            info.StartLine > 0 ? info.StartLine : 1,
            info.StartColumn > 0 ? info.StartColumn : 1));
    }
    sources.Sort((left, right) => right.Name.Length.CompareTo(left.Name.Length));
    return sources;
}

static Diagnostic Place(Diagnostic diagnostic, List<ObjectSource> sources)
{
    if (!string.IsNullOrEmpty(diagnostic.File))
    {
        return diagnostic;
    }
    foreach (var source in sources)
    {
        if (diagnostic.Message.Contains(source.Name, StringComparison.OrdinalIgnoreCase))
        {
            return diagnostic with
            {
                File = source.File,
                Line = source.Line,
                Column = source.Column
            };
        }
    }
    return diagnostic;
}

static (string File, int Line, int Column) Locate(DacModelError error)
{
    var line = error.Line > 0 ? error.Line : 1;
    var column = error.Column > 0 ? error.Column : 1;
    var source = error.SourceName ?? "";
    return File.Exists(source) ? (source, line, column) : ("", line, column);
}

static bool IsParserWarning(string message)
{
    return message.Contains("is ignored", StringComparison.OrdinalIgnoreCase)
        || message.Contains("se ignora", StringComparison.OrdinalIgnoreCase);
}

static Diagnostic? ReadMessage(object message, string fallbackFile)
{
    var type = message.GetType();
    string Text(string name) => type.GetProperty(name)?.GetValue(message)?.ToString() ?? "";
    int Number(string name) => type.GetProperty(name)?.GetValue(message) is int value && value > 0 ? value : 0;
    var severityName = Text("Severity");
    if (string.IsNullOrWhiteSpace(severityName))
    {
        severityName = Text("MessageType");
    }
    var severity = severityName.Contains("Warning", StringComparison.OrdinalIgnoreCase) ? "warning"
        : severityName.Contains("Error", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(severityName) ? "error"
        : "";
    if (severity.Length == 0)
    {
        return null;
    }

    var body = Text("Message");
    var prefix = Text("Prefix");
    var code = Text("Number");
    if (string.IsNullOrWhiteSpace(code))
    {
        code = Text("ErrorCode");
    }
    var label = string.IsNullOrWhiteSpace(prefix) ? code : prefix + code;
    var text = string.IsNullOrWhiteSpace(label) ? body : label + ": " + body;
    if (string.IsNullOrWhiteSpace(text))
    {
        return null;
    }
    if (severity == "error" && IsParserWarning(text))
    {
        severity = "warning";
    }

    var source = Text("SourceName");
    var file = File.Exists(source) ? source : fallbackFile;
    var line = Number("Line");
    var column = Number("Column");
    return new Diagnostic(severity, file, line > 0 ? line : 1, column > 0 ? column : 1, text);
}

static IEnumerable<Diagnostic> ValidationMessages(Exception exception)
{
    var messages = exception.GetType().GetProperty("Messages")?.GetValue(exception) as System.Collections.IEnumerable;
    if (messages == null)
    {
        yield return new Diagnostic("error", "", 1, 1, exception.Message);
        yield break;
    }

    var any = false;
    foreach (var message in messages)
    {
        if (message == null)
        {
            continue;
        }
        any = true;
        var type = message.GetType();
        string Text(string name) => type.GetProperty(name)?.GetValue(message)?.ToString() ?? "";
        var severity = Text("MessageType").Contains("Warning", StringComparison.OrdinalIgnoreCase) ? "warning" : "error";
        var number = Text("Number");
        var prefix = Text("Prefix");
        var body = Text("Message");
        var code = string.IsNullOrWhiteSpace(number) ? prefix : (string.IsNullOrWhiteSpace(prefix) ? number : prefix + number);
        var text = string.IsNullOrWhiteSpace(code) ? body : code + ": " + body;
        yield return new Diagnostic(severity, "", 1, 1, string.IsNullOrWhiteSpace(text) ? exception.Message : text);
    }

    if (!any)
    {
        yield return new Diagnostic("error", "", 1, 1, exception.Message);
    }
}

static bool PublishDatabase(string dacpac, string server, string database, List<Diagnostic> diagnostics)
{
    var password = Environment.GetEnvironmentVariable("MSSQL_SA_PASSWORD") ?? "";
    if (password.Length == 0)
    {
        diagnostics.Add(new Diagnostic("error", "", 1, 1, Ui.Text("The local engine password is missing.", "No está la contraseña del motor local.")));
        return false;
    }
    if (!System.Text.RegularExpressions.Regex.IsMatch(database, "^[A-Za-z0-9_]+$"))
    {
        diagnostics.Add(new Diagnostic("error", "", 1, 1, Ui.Text("The database name is not valid.", "El nombre de la base no es válido.")));
        return false;
    }

    var builder = new Microsoft.Data.SqlClient.SqlConnectionStringBuilder
    {
        DataSource = server,
        UserID = "sa",
        Password = password,
        TrustServerCertificate = true,
        InitialCatalog = "master"
    };
    builder["Encrypt"] = "Optional";

    try
    {
        using var package = DacPackage.Load(dacpac);
        var services = new DacServices(builder.ConnectionString);
        services.Message += (_, eventArgs) =>
        {
            var body = Redact(eventArgs.Message.Message ?? "", password);
            var kind = eventArgs.Message.MessageType.ToString();
            if (kind.Contains("Error", StringComparison.OrdinalIgnoreCase))
            {
                diagnostics.Add(new Diagnostic("error", "", 1, 1, body));
            }
            else if (kind.Contains("Warning", StringComparison.OrdinalIgnoreCase))
            {
                diagnostics.Add(new Diagnostic("warning", "", 1, 1, body));
            }
            if (body.Length > 0)
            {
                Console.Error.WriteLine("status\t" + body);
            }
        };
        Console.Error.WriteLine("status\t" + Ui.Text("Publishing to {0}", "Publicando en {0}").Replace("{0}", database));
        services.Publish(package, database, new PublishOptions
        {
            DeployOptions = new DacDeployOptions
            {
                IgnorePermissions = true,
                IgnoreRoleMembership = true,
                IgnoreUserSettingsObjects = true,
                BlockOnPossibleDataLoss = true,
                DropObjectsNotInSource = false,
                ExcludeObjectTypes =
                [
                    ObjectType.Users,
                    ObjectType.Permissions,
                    ObjectType.RoleMembership
                ]
            }
        });
        return diagnostics.All(item => item.Severity != "error");
    }
    catch (Exception ex)
    {
        var added = false;
        foreach (var message in ValidationMessages(ex))
        {
            diagnostics.Add(message with { Message = Redact(message.Message, password) });
            added = true;
        }
        if (!added)
        {
            diagnostics.Add(new Diagnostic("error", "", 1, 1, Redact(ex.Message, password)));
        }
        return false;
    }
}

static string Redact(string text, string secret)
{
    var clean = string.IsNullOrEmpty(secret) ? text : text.Replace(secret, "***", StringComparison.Ordinal);
    return System.Text.RegularExpressions.Regex.Replace(clean, "(?i)(Password\\s*=\\s*)([^;'\"]+)", "$1***");
}

record Project(string Directory, string Dsp, string Collation, string AssemblyName, bool TreatWarningsAsErrors, List<string> Files);
record ObjectSource(string Name, string File, int Line, int Column);
record Diagnostic(string Severity, string File, int Line, int Column, string Message);
record Result(bool Ok, string Dacpac, IEnumerable<Diagnostic> Diagnostics, bool Published = false);

static class Ui
{
    public static bool Spanish { get; set; }
    public static string Text(string english, string spanish) => Spanish ? spanish : english;
}
