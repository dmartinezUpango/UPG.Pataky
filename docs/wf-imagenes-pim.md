---
tags:
  - Workflows
  - Procesos
  - Imágenes
  - FTP
  - PIM
---

# WF-05 — Imágenes PIM

Sincronización de imágenes desde el servidor FTP hacia el PIM (SalesLayer). El workflow escanea las carpetas configuradas del FTP, genera un fichero CSV con los nombres de todas las imágenes encontradas y lo sube de vuelta al mismo FTP. SalesLayer importa ese CSV automáticamente como parte de su propio proceso de sincronización.

---

## Índice

1. [Resumen](#resumen)
2. [Grafo del workflow](#grafo-del-workflow)
3. [Actividades](#actividades)
4. [Variables del workflow](#variables-del-workflow)
5. [Configuración](#configuracion)
6. [Documentos relacionados](#documentos-relacionados)

---

## Resumen

| Campo | Valor |
|---|---|
| **Clase** | `PicsWorkflow` |
| **Fichero** | `ElsaServer/Workflows/ImagenesPIMWorkflow.cs` |
| **Config key** | `Workflows:ImagesToPIM` |
| **Dirección** | FTP → PIM (SalesLayer) |
| **Trigger** | `PublishEvent("CSV de imágenes para Sales Layer")` |
| **Cron** | `null` — solo ejecución manual desde Elsa Studio |
| **Incremental** | No admite modo incremental |
| **Mirror** | No |

---

## Grafo del workflow

=== ":material-graph: Interactivo"

    <div id="reactflow-root"></div>

    <div id="reactflow-data" style="display:none">
    {
      "height": 260,
      "nodes": [
        {"id":"ftp",  "type":"input",  "data":{"label":"FTP Server"},           "position":{"x":0,   "y":80}},
        {"id":"ex",                    "data":{"label":"LocalImagesExtractor","url":"../wf-imagenes-pim-metodos/#1-localimagesextractor-clase"},  "position":{"x":220, "y":80}},
        {"id":"csv",                   "data":{"label":"CSV_CargaImages.csv"},   "position":{"x":460, "y":0}},
        {"id":"fin",  "type":"output", "data":{"label":"Finish"},                "position":{"x":460, "y":160}},
        {"id":"pim",  "type":"output", "data":{"label":"SalesLayer PIM"},        "position":{"x":700, "y":0}}
      ],
      "edges": [
        {"id":"e1","source":"ftp", "target":"ex",  "label":"lista ficheros",      "animated":true},
        {"id":"e2","source":"ex",  "target":"csv", "label":"sube CSV",            "animated":true},
        {"id":"e3","source":"ex",  "target":"fin", "label":"Box<NasFile>"},
        {"id":"e4","source":"csv", "target":"pim", "label":"importación externa", "animated":true}
      ]
    }
    </div>

=== ":material-chart-timeline-variant: Estático"

    ```mermaid
    flowchart LR
        FTP[("FTP Server")]
        EX["LocalImagesExtractor\nConecta al FTP\nLista ficheros recursivamente\nFiltra por prefijo\nParsea nombre → Reference + Orden\nGenera CSV y lo sube al FTP"]
        FIN(["Finish"])
        CSV["CSV_CargaImages.csv\nen el FTP"]
        PIM["SalesLayer PIM\n(importa el CSV de forma automática)"]

        FTP -. "lista ficheros" .-> EX
        EX -. "sube" .-> CSV
        EX -->|"Box&lt;NasFile&gt; imagenesNas"| FIN
        CSV -. "importación externa" .-> PIM
    ```

> **Nota:** La subida del CSV al PIM ocurre **dentro de `LocalImagesExtractor`**, no en una actividad de carga separada. El workflow solo tiene dos actividades: el extractor y `Finish`.

---

## Actividades

| # | Clave interna | Clase | Tipo | Propósito |
|---|---|---|---|---|
| 1 | `extraerImagenes` | `LocalImagesExtractor` | Extractor | Lee el FTP, parsea ficheros, genera y sube el CSV |
| 2 | `final` | `Finish` *(Elsa built-in)* | Control | Marca el workflow como finalizado |

---

## Variables del workflow

| Variable | Tipo | Descripción |
|---|---|---|
| `imagenesNas` | `Box<NasFile>` | Lista de imágenes encontradas en el FTP, con `Name`, `Reference` y `Orden` parseados |
| `saleslayerInput` | `SalesLayerInput` | **No conectada** — definida en el workflow pero sin actividad que la consuma. Vestigio de una versión anterior donde existía una actividad separada de carga en SalesLayer |

---

## Configuración

El workflow usa la sección `Workflows:ImagesToPIM` de `appsettings.json` para el `WorkflowConfig` (nombre, cron, notificaciones) y la sección `FtpImages` para los parámetros de conexión al FTP (ver [Configuración del sistema — FtpImages](08-configuracion.md#5-ftpimages-servidor-de-imagenes)).

```json title="appsettings.json"
"Workflows": {
  "ImagesToPIM": {
    "Name": "CSV de imágenes para Sales Layer",
    "Cron": null,
    "IncrementalCron": null,
    "Notifications": {
      "Recipients": []
    }
  }
}
```

---

## Documentos relacionados

| Documento | Descripción |
|---|---|
| [Detalle completo](wf-imagenes-pim-detalle.md) | Actividades, configuración FTP y modelo de datos |
| [Métodos y funciones](wf-imagenes-pim-metodos.md) | Lógica interna de `LocalImagesExtractor.RunAsync` |
| [Configuración — FtpImages](08-configuracion.md#5-ftpimages-servidor-de-imagenes) | Parámetros del servidor FTP en `appsettings.json` |
| [Modelos de datos](06-modelos.md) | Modelo `NasFile` |
