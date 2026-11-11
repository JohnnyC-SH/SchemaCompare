# Johnny Schema Compare — spec

**Fecha:** 2026-11-02
**Estado:** acordado en charla. Hay un arranque instalable en VS Code; el compare todavía no está.
**Carpeta:** `Create.IT/Johnny Schema Compare`
**Producto:** extensión de Cursor y VS Code, mismo nombre

## 1. Para qué existe

Comparar el esquema de un proyecto SQL (`.sqlproj` clásico de SSDT) contra una base, elegir objeto por objeto y aplicar solo eso.

Hay dos sentidos:

- **Subir.** De la base al proyecto. Los objetos elegidos se escriben en el `.sqlproj` para commit y push. Eso lo hace **Aplicar**.
- **Bajar.** Del proyecto a la base local. No lo hace Aplicar. Lo hace **Publicar**: se compila el proyecto y el resultado se aplica en `localhost`.

En Windows Johnny **apaga** el Schema Compare de Visual Studio. Esta extensión es la que usa, para que las dos no choquen.

No es un fork de `microsoft/vscode-mssql`. Esa extensión es enorme y el dolor real está en la rejilla de Visual Studio: si marcas todo, después no deja desmarcar de uno en uno. Aquí cada objeto tiene su propio checkbox, y desmarcarlo sigue funcionando después de «seleccionar todo».

## 2. Qué entra y qué no

### Entra

- Comparar proyecto contra base, y al revés. Entran tablas, tipos de tabla (`CREATE TYPE … AS TABLE`, carpeta `User Defined Types`), procedimientos, vistas, funciones y desencadenadores.
- Parar una comparación en curso.
- Lista de diferencias con un checkbox por objeto.
- Seleccionar todo, y poder quitar objetos sueltos después.
- Generar el script de lo seleccionado.
- Aplicar lo seleccionado solo de la base al proyecto. Escribe esos objetos en el `.sqlproj`.
- Publicar el proyecto a la base local: compilar y aplicar el resultado. No es un Aplicar de objetos sueltos.
- Opciones de la comparación.
- Cambiar el sentido (origen y destino se intercambian).
- Abrir y guardar la comparación (origen, destino, opciones y selección) para reabrirla.
- Excluir usuarios y permisos por defecto, en la comparación y al aplicar. Ver sección 5.

### No entra

- Fork de `microsoft/vscode-mssql` ni copiar esa extensión.
- Compare de **datos**. Solo esquema.
- Publicar a un servidor que no sea la base local. El destino de «bajar» es `localhost`.
- Convertir los `.sqlproj` de Haditec a estilo SDK.
- Crear logins, restaurar backups o prender SQL. Eso ya lo hace Doko.
- Tocar Doko, SicoRest ni los demás productos de Create.IT.
- Una máquina virtual de Windows. La extensión corre en Cursor / VS Code en la Mac.

## 3. Cómo se ve

La barra, en este orden, como el Schema Compare que Johnny ya usa:

1. **Compare** — corre la comparación.
2. **Stop** — la corta.
3. **Generate Script** — arma el script de lo marcado, sin aplicarlo.
4. **Apply** — aplica lo marcado.
5. **Options** — abre las opciones (tipos de objeto y exclusiones).
6. **Switch Direction** — intercambia origen y destino.
7. **Open** — abre una comparación guardada.
8. **Save** — guarda la comparación actual.

Origen y destino van debajo de la barra. En la captura de referencia el origen ya apunta a un proyecto y el destino está vacío hasta que se elige la base.

La rejilla de resultados muestra cada diferencia con su checkbox. «Seleccionar todo» marca las filas visibles. Quitar el check de una fila no vuelve a marcar las demás ni se queda trabado.

El archivo guardado tiene que reabrir la misma comparación: rutas, sentido, opciones y selección. No hace falta que sea un `.scmp` de Visual Studio byte por byte. Los botones pueden decir Open / Save `.scmp` porque así se llama la acción en la herramienta que estamos reemplazando.

## 4. Sentidos

| Sentido | Origen | Destino | Cómo se aplican los cambios |
|---------|--------|---------|----------------------------|
| Subir | Base | Proyecto `.sqlproj` | **Aplicar** escribe en el proyecto solo los objetos marcados, para commit y push |
| Bajar | Proyecto `.sqlproj` | Base local | **Aplicar** avisa y ejecuta en la base solo los objetos marcados. **Publicar** compila el proyecto completo y aplica todo el resultado en `localhost` |

Switch Direction pasa de uno al otro sin perder las opciones. La selección se recalcula al volver a comparar, porque las diferencias cambian de lado.

Generate Script nunca escribe en el proyecto ni en la base. Aplicar solo toca lo marcado. Si el origen es la base y el destino el proyecto, escribe esos objetos en el proyecto. Si el origen es el proyecto y el destino la base, avisa y ejecuta solo esos objetos en la base. Si no hay nada marcado, Aplicar no hace nada. Publicar no usa la selección de la rejilla: publica el proyecto compilado completo.

## 5. Usuarios y permisos (ProyectoBD.pdf)

Además del compare, la comparación y la publicación salen **sin** usuarios ni permisos. Es el proceso del PDF `~/Downloads/ProyectoBD.pdf` («Omitir Usuarios en Proyecto de Base de Datos»), dejado como default para no hacerlo a mano cada vez.

Quedan **fuera** por defecto:

1. Permisos
2. Pertenencia a roles
3. Usuarios

En la comparación eso equivale a desmarcar, en Tipos de objeto → «Con ámbito en la aplicación»:

- Permisos
- Pertenencias a roles
- Usuarios

Al aplicar (publicar) eso equivale a marcar, en Avanzada → pestaña Ignorar → «Excluir tipos de objetos»:

- Excluir permisos
- Excluir pertenencia a roles
- Excluir usuarios

Esas tres exclusiones nacen activas y se ven en Options, para poder encenderlas en una comparación concreta. El resto de casillas que aparecen en las capturas del PDF (tamaño de archivo, filegroup, mayúsculas en palabras clave, ANSI nulls, NOCHECK, etc.) son el estado del diálogo de Visual Studio. **No** son requisito de este producto.

Los logins `uANCLO` y `userMg` sirven para conectarse. No son objetos del esquema y no deben salir en el diff.

## 6. Proyectos y bases de prueba

El conejillo de indias es **dbANCLO**. Margaritas usa el mismo flujo cuando ANCLO ya compara bien. No se editan esos proyectos al construir la extensión.

| | ANCLO | Margaritas |
|--|--|--|
| Base local | `dbANCLO` | `dbMargaritas` |
| Proyecto | `Haditec/BD-ANCLO-2026/Anclo BD 2026/Anclo BD 2026.sqlproj` | `Haditec/Margaritas-BD/BdMargaritas/BdMargaritas.sqlproj` |
| Tipo | SSDT clásico, `ToolsVersion` 4.0, no SDK | Igual |
| DSP | `Sql160DatabaseSchemaProvider` | `Sql150DatabaseSchemaProvider` |
| Collation del proyecto | `Modern_Spanish_CI_AS` | la que ya trae el `.sqlproj` |
| Nombre MSBuild | `Anclo_BD_2026` | `BdMargaritas` |

Rutas absolutas en esta Mac:

- `/Users/johnny/Documents/JohnnyProjects/Haditec/BD-ANCLO-2026/Anclo BD 2026/Anclo BD 2026.sqlproj`
- `/Users/johnny/Documents/JohnnyProjects/Haditec/Margaritas-BD/BdMargaritas/BdMargaritas.sqlproj`

La base local es SQL Server 2022 en el contenedor `sqlserver`, puerto 1433, nombre de servidor **`localhost`**. Lo prende Doko (Colima). Esta extensión no arranca ni apaga el motor.

Conexión de prueba: `localhost`, base `dbANCLO`, login SQL (en Mac no hay `Trusted_Connection`). La contraseña de `sa` vive en el llavero de Doko. **No** se copia a este repo, ni a settings commiteados, ni a este spec.

## 7. Motor

Motor de compare y de script: **DacFx** (`Microsoft.SqlServer.DacFx`), dentro de una extensión chica.

Tiene que funcionar en la Mac de Johnny (Intel, sin Homebrew) hablando con `localhost`. No depende de Visual Studio ni de compilar el `.sqlproj` con MSBuild de Windows.

El `.sqlproj` se queda clásico. Si DacFx no puede leer ese formato en Mac, se para y se le dice a Johnny. No se convierte el proyecto a estilo SDK por cuenta propia.

El menú del proyecto es **Limpiar**, **Compilar**, **Publicar** y **Comparar**. Compilar lee los `Build Include` con DacFx, sin MSBuild de Windows. Si hay errores, quedan en el panel Problemas y no se escribe el dacpac. Si no los hay, queda `bin/Debug/<AssemblyName>.dacpac`. Limpiar quita `bin` y `obj` solo del proyecto al que se le abrió el menú. No toca el código ni los demás proyectos.

Publicar abre un modal para elegir la conexión local y la base. Compila el proyecto y aplica el resultado completo en esa base. No publica usuarios, permisos ni pertenencia a roles. No borra objetos que solo están en la base. Si un cambio borraría datos, se detiene y lo informa.

La extensión se instala en Cursor y en VS Code. Identificadores y código en inglés. La UI sigue el idioma de VS Code: inglés por defecto y español cuando el idioma de visualización es `es`.

## 8. Entorno de esta Mac

- Intel 2019, sin Homebrew. Nada del producto puede exigir `brew`.
- SQL local solo vía Doko: Colima, contenedor `sqlserver`, `localhost:1433`.
- Doko es otro producto (`Create.IT/Doko`). No se mezcla código ni se le añaden pantallas.
- Haditec vive fuera de esta carpeta. La extensión lo abre como carpeta de proyecto; el repo de la extensión no contiene los `.sqlproj`.

## 9. Hecho cuando

1. En Cursor, con `dbANCLO` en `localhost` y el `.sqlproj` de ANCLO, Compare lista diferencias de esquema.
2. Usuarios, permisos y pertenencia a roles no aparecen, con las opciones por defecto.
3. Se pueden marcar todos y luego quitar uno sin que el check se vuelva a poner solo.
4. Switch Direction invierte origen y destino.
5. Generate Script muestra el T-SQL de lo marcado y no toca disco ni la base.
6. Aplicar, con la base como origen y el proyecto como destino, escribe solo los objetos marcados en el `.sqlproj`.
7. Publicar compila el proyecto y aplica el resultado en `dbANCLO`. Aplicar no escribe en la base.
8. Save y Open recuperan origen, destino, opciones y selección.
9. El mismo flujo abre el proyecto de Margaritas sin cambiar código.

## 10. Abierto (no inventar)

- Publisher `t1gr3ju4nmx` (el de .NET Convenience). Id `johnny-schema-compare`, o sea `t1gr3ju4nmx.johnny-schema-compare`. Icono `Logo/Comparar128.png`; en `Logo/` también están 64, 256 y 512.
- Si algún día hará falta un `.scmp` intercambiable con Visual Studio.
- Repo local inicializado, `origin` en `https://github.com/JohnnyC-SH/SchemaCompare.git`. No hacer commit ni push hasta que Johnny lo pida.
