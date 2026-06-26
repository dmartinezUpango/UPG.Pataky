---
tags:
  - Workflows
  - Procesos
  - Imágenes
  - FTP
  - PIM
---

# WF-05 — Imágenes PIM: Métodos y funciones

---

## Índice

1. [LocalImagesExtractor — clase](#1-localimagesextractor-clase)
2. [InitInputs](#2-initinputs)
3. [ShouldRunAsync](#3-shouldrunasync)
4. [RunAsync — conexión FTP y listado de ficheros](#4-runasync-conexion-ftp-y-listado-de-ficheros)
5. [RunAsync — parseo del nombre de fichero](#5-runasync-parseo-del-nombre-de-fichero)
6. [RunAsync — generación y subida del CSV](#6-runasync-generacion-y-subida-del-csv)

---

## 1. `LocalImagesExtractor` — clase

**Fichero:** `Extractors/PicsLocalExtractor.cs`
**Namespace:** `Extractors`
**Hereda de:** `BaseActivity<LocalImagesExtractor>`

```csharp
public class LocalImagesExtractor : BaseActivity<LocalImagesExtractor>
{
    [Output]
    public required Output<Box<NasFile>> Output { get; set; }
    ...
}
```

La clase declara un único output: `Output<Box<NasFile>>`, que es la lista de ficheros encontrados en el FTP. No declara inputs — toda su configuración viene de `IConfiguration` dentro de `RunAsync`.

La propiedad lleva el atributo `[Output]` de Elsa, que la registra en el grafo del workflow y permite que otras actividades la lean como variable (en este workflow, solo la recibe la variable `imagenesNas`).

---

## 2. `InitInputs`

```csharp
protected override void InitInputs(ActivityExecutionContext context)
{
}
```

Sin inputs del workflow — el método está vacío. Toda la configuración se lee directamente de `IConfiguration` en `RunAsync`.

---

## 3. `ShouldRunAsync`

```csharp
protected override bool ShouldRunAsync() => true;
```

El extractor siempre se ejecuta. No hay condición de cortocircuito.

---

## 4. `RunAsync` — conexión FTP y listado de ficheros

```csharp title="PicsLocalExtractor.cs"
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var cfg = context.GetRequiredService<IConfiguration>().GetSection("FtpImages"); // (1)!

    var host    = cfg.GetValue<string>("Host")!;
    var port    = cfg.GetValue<int?>("Port") ?? 21;
    var user    = cfg.GetValue<string>("Username")!;
    var pass    = cfg.GetValue<string>("Password")!;
    var folders = cfg.GetSection("RemoteFolders").Get<List<string>>() ?? new();
    var usePassive          = cfg.GetValue<bool?>("UsePassive") ?? true;
    var fileNameStartsWith  = cfg.GetSection("FileNameStartsWith").Get<List<string>>() ?? new();

    var allFiles = new List<NasFile>();

    await using var client = new AsyncFtpClient(host, port); // (2)!
    client.Credentials = new NetworkCredential(user, pass);
    client.Config.DataConnectionType = usePassive
        ? FtpDataConnectionType.AutoPassive
        : FtpDataConnectionType.AutoActive; // (3)!

    await client.Connect();

    foreach (var folder in folders)
    {
        var items = await client.GetListing(folder, FtpListOption.Recursive); // (4)!

        foreach (var item in items.Where(x => x.Type == FtpObjectType.File))
        {
            var fileName = item.Name;

            if (fileName.Equals("CSV_CargaImages.csv", StringComparison.OrdinalIgnoreCase)) // (5)!
                continue;

            if (fileNameStartsWith.Count > 0 &&
                !fileNameStartsWith.Any(prefix => fileName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))) // (6)!
                continue;

            // ... parseo del nombre (ver sección 5)
        }
    }
```
1. Lee la sección `FtpImages` de `appsettings.json`. Se obtiene del contenedor de dependencias del workflow, que inyecta `IConfiguration` de ASP.NET Core.
2. `AsyncFtpClient` es el cliente de [FluentFTP](https://github.com/robinrodricks/FluentFTP), la librería FTP del proyecto. Se usa `await using` para garantizar la desconexión aunque ocurra una excepción.
3. **Modo pasivo vs activo:** en modo pasivo (`AutoPassive`) el servidor FTP abre el puerto de datos — necesario cuando el cliente está detrás de un firewall o NAT (como en producción). En modo activo es el cliente quien abre el puerto.
4. `FtpListOption.Recursive` lista todos los ficheros de la carpeta y sus subdirectorios en una sola llamada.
5. El propio extractor sube el CSV al FTP en cada ejecución. Si no se filtrara, en la siguiente ejecución el CSV aparecería en el listado y se incluiría en sí mismo.
6. Si `FileNameStartsWith` tiene valores, solo se procesan los ficheros cuyos nombres empiezan por alguno de los prefijos (case-insensitive). Si la lista está vacía, no se aplica ningún filtro.

---

## 5. `RunAsync` — parseo del nombre de fichero

```csharp title="PicsLocalExtractor.cs"
var nameNoExt = Path.GetFileNameWithoutExtension(fileName); // (1)!

var parts = nameNoExt.Split('-', // (2)!
    StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

var orden     = parts.Length >= 2 ? parts[^1] : "0"; // (3)!
var reference = parts.Length >= 2
    ? string.Join('-', parts.Take(parts.Length - 1))  // (4)!
    : nameNoExt;

allFiles.Add(new NasFile
{
    Name      = fileName,
    Folder    = Path.GetDirectoryName(item.FullName)!.Replace("\\", "/"),
    FullPath  = item.FullName,
    Reference = reference,
    Orden     = orden
});
```
1. Elimina la extensión del nombre de fichero antes de parsearlo: `GHD001-3.jpg` → `GHD001-3`.
2. Divide por guión (`-`). `RemoveEmptyEntries` elimina segmentos vacíos si hay guiones dobles. `TrimEntries` elimina espacios en los extremos de cada parte.
3. **Orden:** el **último** segmento del nombre (`parts[^1]`). Si el nombre no tiene guiones (`parts.Length < 2`), el orden por defecto es `"0"`.
4. **Reference:** todos los segmentos **excepto el último**, reunidos de nuevo con guiones. Así `GHD-ALISADOR-PRO-2` → `parts = ["GHD","ALISADOR","PRO","2"]` → `reference = "GHD-ALISADOR-PRO"`.

### Tabla de ejemplos

| Fichero | `nameNoExt` | `parts` | `Reference` | `Orden` |
|---|---|---|---|---|
| `GHD001-1.jpg` | `GHD001-1` | `["GHD001","1"]` | `GHD001` | `1` |
| `GHD-ALISADOR-PRO-2.jpg` | `GHD-ALISADOR-PRO-2` | `["GHD","ALISADOR","PRO","2"]` | `GHD-ALISADOR-PRO` | `2` |
| `SECHE-VITE.png` | `SECHE-VITE` | `["SECHE","VITE"]` | `SECHE` | `VITE` |
| `LOGO.png` | `LOGO` | `["LOGO"]` | `LOGO` | `0` |

> **Atención con `SECHE-VITE.png`:** el parseo asume que el último segmento siempre es un número de orden. Si un nombre de fichero termina en texto (no en número), `Orden` tendrá ese texto. No causa errores en el flujo actual porque `Orden` se usa solo como metadato informativo, no se valida como número.

---

## 6. `RunAsync` — generación y subida del CSV

```csharp title="PicsLocalExtractor.cs"
var remoteFolder = folders.First(); // (1)!
var csvRemotePath = $"{remoteFolder.TrimEnd('/')}/CSV_CargaImages.csv";

var imageNames = allFiles
    .Select(x => x.Name)
    .Distinct()       // (2)!
    .OrderBy(x => x)  // (3)!
    .ToList();

var csvContent = "Imagen" + Environment.NewLine +    // (4)!
                 string.Join(Environment.NewLine, imageNames);

await using var csvStream = new MemoryStream(          // (5)!
    System.Text.Encoding.UTF8.GetBytes(csvContent));

await client.UploadStream(
    csvStream,
    csvRemotePath,
    FtpRemoteExists.Overwrite, // (6)!
    createRemoteDir: true);

Output.Set(context, new Box<NasFile>(allFiles)); // (7)!

return new ActivityResult
{
    InformationLogs =
    [
        $"Recuperadas {allFiles.Count} imágenes agrupadas en " +
        $"{allFiles.Select(x => x.Reference).Distinct().Count()} referencias."
    ]
};
```
1. El CSV siempre se sube a la **primera** carpeta de `RemoteFolders`, independientemente de en cuántas carpetas se haya buscado.
2. `Distinct()` elimina duplicados por si un mismo fichero aparece varias veces en el listado (no debería ocurrir, pero es una salvaguarda).
3. El orden alfabético hace el CSV predecible y reproducible entre ejecuciones.
4. La columna se llama exactamente `Imagen` — es el nombre que espera SalesLayer para importar imágenes. No cambiarlo sin actualizar la configuración del canal en el PIM.
5. El CSV se construye en memoria como `MemoryStream` en lugar de escribirlo en disco primero. Evita archivos temporales y es más rápido para ficheros pequeños.
6. `FtpRemoteExists.Overwrite` sobreescribe el CSV si ya existe. Cada ejecución genera un CSV completo y fresco — no acumulativo.
7. Registra la lista de `NasFile` en la variable de workflow `imagenesNas`. Aunque en este workflow no hay ninguna actividad que consuma ese output, el valor queda disponible en el estado de Elsa Studio para inspección.
