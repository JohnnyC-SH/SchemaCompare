# ContextResume — Johnny Schema Compare

| | |
|--|--|
| **Qué es** | Extensión de Cursor y VS Code para comparar un `.sqlproj` clásico contra SQL Server local, objeto por objeto |
| **Spec** | `docs/superpowers/specs/2026-11-02-johnny-schema-compare-design.md` |
| **Agente** | `AGENTS.md` |
| **Estado** | Spec escrito el 2026-11-02. Repo local sin commit. Al elegir una conexión local, las bases se leen del motor, no de la base guardada en el perfil |
| **Comparar** | Rejilla clásica con Agregar, Quitar y Cambiar. El detalle pinta el SQL, marca verde/rojo y tiene mapa. La barra entre la lista y el detalle se arrastra; el botón del centro la sube hasta dejar unos 30 px de lista y el segundo clic la regresa. Scroll de los dos lados junto. Check centrado y fijo; los nombres se ensanchan. Aplicar con base→proyecto escribe procedimientos, vistas, funciones y desencadenadores. Aplicar con proyecto→base avisa y ejecuta solo los marcados, tablas incluidas. Quitar o cambiar una tabla avisa que se pierden sus datos. Menú del proyecto: Limpiar, Compilar, Publicar, Comparar. Limpiar quita bin y obj solo del proyecto al que se le abrió el menú. Compilar arma el dacpac con DacFx y reporta errores en Problemas. ANCLO compiló sin errores y con 182 advertencias, casi todas SQL71502. Publicar abre un modal, elige la base local y aplica el proyecto completo. Omite usuarios, permisos y pertenencia a roles. No borra lo que solo está en la base. Si un cambio borraría datos, se detiene |
| **Instalación** | `t1gr3ju4nmx.johnny-schema-compare@0.0.1` en VS Code. Esta Mac no tiene Node; el `.vsix` se armó a mano y está en el repo (git lo ignora) |
| **Remoto** | `https://github.com/JohnnyC-SH/SchemaCompare.git` |
| **Extensión** | `t1gr3ju4nmx.johnny-schema-compare`, icono `Logo/Comparar128.png` |

## Arranque

1. Leer el spec completo antes de proponer código.
2. Conejo de indias: base `dbANCLO` en `localhost`, proyecto `Haditec/BD-ANCLO-2026/Anclo BD 2026/Anclo BD 2026.sqlproj`.
3. Default de negocio: la comparación y el apply excluyen permisos, pertenencia a roles y usuarios.
4. No fork de `vscode-mssql`. Motor: DacFx. El checkbox de cada objeto se puede quitar aunque se haya marcado todo.
5. SQL local lo prende Doko. Esta extensión no administra Colima ni el contenedor.
