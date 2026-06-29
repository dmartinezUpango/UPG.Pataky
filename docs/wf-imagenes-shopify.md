---
tags:
  - Workflows
  - Procesos
  - Imágenes
  - PIM
  - Shopify
---

# WF-06 — Imágenes Shopify

Sincronización de imágenes de producto desde el PIM (SalesLayer) hacia Shopify. El workflow extrae las imágenes de los productos del canal PIM, las compara con el estado actual de Shopify vía Mirror (`SyncProductMedias`), decide qué crear/editar/borrar/asociar/desasociar, y ejecuta las operaciones necesarias.

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
| **Clase** | `ImagenesShopifyWorkflow` |
| **Fichero** | `ElsaServer/Workflows/ImagenesShopifyWorkflow.cs` |
| **Config key** | `Workflows:ImagesToShopify` |
| **Dirección** | PIM (SalesLayer) → Shopify |
| **Trigger** | `PublishEvent("Imágenes hacia Shopify")` |
| **Cron** | `null` — solo ejecución manual desde Elsa Studio |
| **Incremental** | No |
| **Mirror** | Sí — `SyncProductMedias` |

---

## Grafo del workflow

=== ":material-graph: Interactivo"

    <div id="reactflow-root"></div>

    <div id="reactflow-data" style="display:none">
    {
      "height": 760,
      "nodes": [
        {"id":"pim",          "type":"input",  "data":{"label":"PIM SalesLayer"},           "position":{"x":0,   "y":0}},
        {"id":"shopify_src",  "type":"input",  "data":{"label":"Shopify ProductMedias"},     "position":{"x":530, "y":0}},
        {"id":"sync",                          "data":{"label":"SyncProductMedias"},         "position":{"x":530, "y":110}},
        {"id":"extract",                       "data":{"label":"ProductsWithImagesExtract","url":"../wf-productos-metodos/#1-productswithimagesextract-clase"}, "position":{"x":200, "y":240}},
        {"id":"decision",                      "data":{"label":"ImageDecision"},             "position":{"x":200, "y":370}},
        {"id":"transform",                     "data":{"label":"ImagesTransform","url":"../wf-imagenes-shopify-metodos/#1-imagestransform-clase"},           "position":{"x":200, "y":500}},
        {"id":"loader",                        "data":{"label":"ProductsMedias"},            "position":{"x":200, "y":630}},
        {"id":"shopify_dst",  "type":"output", "data":{"label":"Shopify ProductMedias"},     "position":{"x":200, "y":760}}
      ],
      "edges": [
        {"id":"e1","source":"shopify_src","target":"sync",        "label":"bulk query",               "animated":true},
        {"id":"e2","source":"sync",       "target":"extract",     "label":"TransactionsDB sync"},
        {"id":"e3","source":"pim",        "target":"extract",     "label":"GetInfoAsync()",            "animated":true},
        {"id":"e4","source":"extract",    "target":"decision",    "label":"Box<IProductImage>"},
        {"id":"e5","source":"decision",   "target":"transform"},
        {"id":"e6","source":"transform",  "target":"loader",      "label":"ProductsMediasLoaderInput"},
        {"id":"e7","source":"loader",     "target":"shopify_dst", "label":"mutations",                "animated":true}
      ]
    }
    </div>

=== ":material-chart-timeline-variant: Estático"

    ```mermaid
    flowchart LR
        PIM[("PIM\nSalesLayer\nCanalSalida")]
        SHOPIFY[("Shopify\nProductMedias")]
        SYNC["SyncProductMedias\nBulk query → TransactionsDB\nMedias actuales de Shopify"]
        EX["ProductsWithImagesExtract\nRecupera productos e imágenes\ndel PIM (CanalSalida)"]
        DEC["ImageDecision\nCrear / Editar / Borrar\nAsociar / Desasociar variante↔media"]
        TR["ImagesTransform\nResuelve OriginIds → ShopifyIds\nConstruye ProductsMediasLoaderInput"]
        LD["ProductsMedias\nEjecuta operaciones\nsobre medias en Shopify"]

        SHOPIFY -. "bulk query" .-> SYNC
        PIM -. "GetInfoAsync()" .-> EX
        SYNC --> EX
        EX -->|"Box&lt;IProductImage&gt; imagenes"| DEC
        DEC --> TR
        TR -->|"ProductsMediasLoaderInput inputLoader"| LD
        LD -. "mutations" .-> SHOPIFY
    ```

---

## Actividades

| # | Clave interna | Clase | Tipo | Propósito |
|---|---|---|---|---|
| 1 | `sync` | `SyncProductMedias` *(Loaders)* | Mirror | Sincroniza el estado de medias de Shopify en TransactionsDB |
| 2 | `extraccion` | `ProductsWithImagesExtract` | Extractor | Lee productos e imágenes del canal PIM |
| 3 | `decision` | `ImageDecision` *(Loaders)* | Decision | Clasifica imágenes en crear/editar/borrar/asociar/desasociar |
| 4 | `transformacion` | `ImagesTransform` | Transformer | Resuelve IDs y construye el input para el loader |
| 5 | `carga` | `ProductsMedias` *(Loaders)* | Loader | Ejecuta todas las operaciones de medias en Shopify |

> `ProductsWithImagesExtract` es **compartida** con el workflow de Productos. Aquí usa el output `ProductsImagesOutput` e ignora `ProductsOutput`.

---

## Variables del workflow

| Variable | Tipo | Descripción |
|---|---|---|
| `imagenes` | `Box<IProductImage>` | Imágenes extraídas del PIM (todas: producto + variante) |
| `imagenesCrear` | `Box<IProductImage>` | Imágenes nuevas a subir a Shopify |
| `imagenesEditar` | `Box<IProductImage>` | Imágenes existentes a actualizar (URL cambiada) |
| `imagenesBorrar` | `Box<string>` | OriginIds de imágenes a eliminar de Shopify |
| `imagenesAsociar` | `Box<(ProductOriginId, VariantOriginId, ImageOriginId)>` | Asociaciones variante↔media a crear |
| `imagenesDesasociar` | `Box<(ProductOriginId, VariantOriginId, ImageOriginId)>` | Asociaciones variante↔media a eliminar |
| `inputLoader` | `ProductsMediasLoaderInput` | Instrucciones completas para `ProductsMedias` |

---

## Configuración

```json title="appsettings.json"
"Workflows": {
  "ImagesToShopify": {
    "Name": "Imágenes hacia Shopify",
    "Cron": null,
    "IncrementalCron": null,
    "Notifications": {
      "Recipients": []
    }
  }
}
```

Las imágenes se leen del canal `PIM:CanalSalida`. Los IDs de destino en Shopify se resuelven consultando `TransactionsDB`.

---

## Documentos relacionados

| Documento | Descripción |
|---|---|
| [Detalle completo](wf-imagenes-shopify-detalle.md) | Actividades, modelo de imagen y lógica de Mirror |
| [Métodos y funciones](wf-imagenes-shopify-metodos.md) | Código anotado de `ImagesTransform` |
| [WF-01 — Productos](wf-productos.md) | Comparte `ProductsWithImagesExtract` |
| [Configuración — PIM](08-configuracion.md) | `PIM:CanalSalida` |
