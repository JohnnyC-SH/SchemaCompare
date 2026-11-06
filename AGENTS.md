# Johnny Schema Compare — instrucciones para agentes

## Fuente de verdad

1. `docs/superpowers/specs/2026-11-02-johnny-schema-compare-design.md`
2. `ContextResume.md`

Si algo no está en el spec, se pregunta. No se rellena con el comportamiento de Visual Studio ni con el de `microsoft/vscode-mssql`.

## Alcance

- Esta carpeta es **solo** la extensión Johnny Schema Compare.
- Doko, Haditec, SicoRest y el resto de Create.IT no se modifican para construirla.
- Los `.sqlproj` de ANCLO y Margaritas son la prueba. No se convierten a estilo SDK ni se editan a mano.
- No hay fork de `microsoft/vscode-mssql`.

## Idioma

- Specs, planes y notas para Johnny: español.
- Código, ids y APIs: inglés.
- UI de la extensión: inglés si el idioma de VS Code no es español; español con `package.nls.es.json` y `l10n/bundle.l10n.es.json` cuando el idioma de visualización es `es`.

## Git

- Commits solo si Johnny lo pide, bajo su usuario del repo.
- Nunca `Co-authored-by: Cursor` ni otros trailers de coautoría de IA.
- No push, no `--no-verify`, no force push a `main`.
- Repo local inicializado. `origin`: `https://github.com/JohnnyC-SH/SchemaCompare.git`.
- Ficha de publicación: mismo publisher, licencia, autor y sponsor que .NET Convenience. Id `johnny-schema-compare`, icono `Logo/Comparar128.png`.

## Secretos

- No guardar contraseñas de `sa`, `uANCLO` ni `userMg` en código, settings del repo ni en el spec.
