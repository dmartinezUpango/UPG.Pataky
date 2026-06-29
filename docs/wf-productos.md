---
tags:
  - Workflows
  - Procesos
  - Productos
  - PIM
  - Shopify
---

# WF-01 — Productos

Sincronización completa de productos desde el PIM (SalesLayer) hacia Shopify. Es el workflow más complejo del sistema: incluye Mirror, extracción del PIM, una decisión que clasifica cada producto y variante, y **tres ramas paralelas** para crear, actualizar y eliminar. Gestiona productos simples y con variantes, archivado, reconstrucción de opciones y publicación en mercados.

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
| **Clase** | `ProductsWorkflow` |
| **Fichero** | `ElsaServer/Workflows/ProductsWorkflow.cs` |
| **Config key** | `Workflows:Products` |
| **Dirección** | PIM (SalesLayer) → Shopify |
| **Trigger** | `PublishEvent("Productos")` |
| **Cron** | `null` — solo ejecución manual desde Elsa Studio |
| **Incremental** | No |
| **Mirror** | Sí — `SyncProducts` |

---

## Grafo del workflow

=== ":material-graph: Interactivo"

    <div id="reactflow-root"></div>

    <div id="reactflow-data" style="display:none">
    {
      "height": 760,
      "nodes": [
        {"id":"pim",          "type":"input",  "data":{"label":"PIM SalesLayer"},           "position":{"x":0,   "y":0}},
        {"id":"shopify_src",  "type":"input",  "data":{"label":"Shopify Products API"},      "position":{"x":580, "y":0}},
        {"id":"sync",                          "data":{"label":"SyncProducts"},              "position":{"x":580, "y":110}},
        {"id":"extract",                       "data":{"label":"ProductsWithImagesExtract","url":"../wf-productos-metodos/#1-productswithimagesextract-clase"}, "position":{"x":220, "y":240}},
        {"id":"decision",                      "data":{"label":"ProductsRebuildDecision","url":"../wf-productos-metodos/#3-productsrebuilddecision-clase"},   "position":{"x":220, "y":370}},
        {"id":"ct",                            "data":{"label":"ProductsCreateTransform","url":"../wf-productos-metodos/#6-productscreatetransform-shouldrunasync"},   "position":{"x":0,   "y":510}},
        {"id":"tu",                            "data":{"label":"ProductsUpdateTransform","url":"../wf-productos-metodos/#7-productsupdatetransform-archivado"},   "position":{"x":220, "y":510}},
        {"id":"td",                            "data":{"label":"ProductsDeleteTransform","url":"../wf-productos-metodos/#8-productsdeletetransform-runasync"},   "position":{"x":460, "y":510}},
        {"id":"cl",                            "data":{"label":"ProductsWithVariantsCreate"},"position":{"x":0,   "y":640}},
        {"id":"lu",                            "data":{"label":"ProductsWithVariantsUpdate"},"position":{"x":220, "y":640}},
        {"id":"dl",                            "data":{"label":"ProductsWithVariantsDelete"},"position":{"x":460, "y":640}},
        {"id":"shopify_dst",  "type":"output", "data":{"label":"Shopify Products API"},      "position":{"x":220, "y":770}}
      ],
      "edges": [
        {"id":"e1",  "source":"shopify_src","target":"sync",        "label":"bulk query",              "animated":true},
        {"id":"e2",  "source":"sync",       "target":"extract",     "label":"TransactionsDB sync"},
        {"id":"e3",  "source":"pim",        "target":"extract",     "label":"GetInfoAsync()",           "animated":true},
        {"id":"e4",  "source":"extract",    "target":"decision",    "label":"Box<IProduct>"},
        {"id":"e5",  "source":"decision",   "target":"ct",          "label":"productosCrear"},
        {"id":"e6",  "source":"decision",   "target":"tu",          "label":"productosActualizar"},
        {"id":"e7",  "source":"decision",   "target":"td",          "label":"productosBorrar"},
        {"id":"e8",  "source":"ct",         "target":"cl",          "label":"inputProductosCrear"},
        {"id":"e9",  "source":"tu",         "target":"lu",          "label":"inputProductosActualizar"},
        {"id":"e10", "source":"td",         "target":"dl",          "label":"inputProductosEliminar"},
        {"id":"e11", "source":"cl",         "target":"shopify_dst", "label":"mutations",               "animated":true},
        {"id":"e12", "source":"lu",         "target":"shopify_dst", "label":"mutations",               "animated":true},
        {"id":"e13", "source":"dl",         "target":"shopify_dst", "label":"mutations",               "animated":true}
      ]
    }
    </div>

=== ":material-chart-timeline-variant: Estático"

    ```mermaid
    flowchart TD
        PIM[("PIM\nSalesLayer\nCanalSalida")]
        SHOPIFY[("Shopify\nProducts API")]
        SYNC["SyncProducts\nBulk query productos/variantes\n→ TransactionsDB"]
        EX["ProductsWithImagesExtract\nGetInfoAsync() del PIM\nProductos simples y con variantes"]
        DEC["ProductsRebuildDecision\nCruza PIM con TransactionsDB\n8 outputs: crear/actualizar/archivar/borrar\n+ variantes + opciones"]

        TC["ProductsCreateTransform"]
        TU["ProductsUpdateTransform\n(incluye archivar + rebuild)"]
        TD["ProductsDeleteTransform"]

        LC["ProductsWithVariantsCreate"]
        LU["ProductsWithVariantsUpdate"]
        LD["ProductsWithVariantsDelete"]

        SHOPIFY -. "bulk query" .-> SYNC
        SYNC --> EX
        PIM -. "GetInfoAsync()" .-> EX
        EX -->|"Box&lt;IProduct&gt; productos"| DEC
        DEC -->|"productosCrear + variantesCrear"| TC
        DEC -->|"productosActualizar + variantesActualizar\n+ productosArchivar + rebuildOptions"| TU
        DEC -->|"productosBorrar + variantesBorrar"| TD
        TC -->|"inputProductosCrear"| LC
        TU -->|"inputProductosActualizar"| LU
        TD -->|"inputProductosEliminar"| LD
        LC -. "mutations" .-> SHOPIFY
        LU -. "mutations" .-> SHOPIFY
        LD -. "mutations" .-> SHOPIFY
    ```

> Las tres ramas (crear / actualizar / eliminar) se conectan **en paralelo** desde `ProductsRebuildDecision`. Elsa las ejecuta todas simultáneamente.

---

## Actividades

| # | Clave interna | Clase | Tipo | Propósito |
|---|---|---|---|---|
| 1 | `syncProductos` | `SyncProducts` *(Loaders)* | Mirror | Lee el estado actual de Shopify en TransactionsDB |
| 2 | `extraccionProductos` | `ProductsWithImagesExtract` | Extractor | Recupera productos e imágenes del canal PIM |
| 3 | `decisionProductos` | `ProductsRebuildDecision` | Decision | Clasifica cada producto y variante en crear/actualizar/archivar/borrar/rebuild |
| 4 | `transformarCrearProductos` | `ProductsCreateTransform` | Transformer | Mapea productos/variantes nuevos a input de creación |
| 5 | `transformarActualizarProductos` | `ProductsUpdateTransform` | Transformer | Mapea actualizaciones, archivados y reconstrucción de opciones |
| 6 | `transformarEliminarProductos` | `ProductsDeleteTransform` | Transformer | Mapea productos/variantes a eliminar |
| 7 | `crearProductos` | `ProductsWithVariantsCreate` *(Loaders)* | Loader | Crea productos y variantes en Shopify |
| 8 | `actualizarProductos` | `ProductsWithVariantsUpdate` *(Loaders)* | Loader | Actualiza productos y variantes en Shopify |
| 9 | `eliminarProductos` | `ProductsWithVariantsDelete` *(Loaders)* | Loader | Elimina productos y variantes en Shopify |

---

## Variables del workflow

| Variable | Tipo | Descripción |
|---|---|---|
| `productos` | `Box<IProduct>` | Todos los productos extraídos del PIM |
| `productosCrear` | `Box<IProduct>` | Productos nuevos (no existen en TransactionsDB) |
| `productosActualizar` | `Box<IProduct>` | Productos existentes a actualizar |
| `productosArchivar` | `Box<string>` | OriginIds de productos a archivar en Shopify |
| `productosBorrar` | `Box<string>` | OriginIds de productos a borrar definitivamente |
| `variantesCrear` | `Box<IVariant>` | Variantes nuevas de productos existentes |
| `variantesActualizar` | `Box<IVariant>` | Variantes existentes a actualizar |
| `variantesBorrar` | `Box<string>` | OriginIds de variantes a eliminar |
| `rebuildProductOptionsDecision` | `Box<IProduct>` | Productos cuyas opciones cambiaron y deben reconstruirse |
| `inputProductosCrear` | `ProductsWithVariantsCreateLoaderInput` | Input listo para `ProductsWithVariantsCreate` |
| `inputProductosActualizar` | `ProductsWithVariantsUpdateLoaderInput` | Input listo para `ProductsWithVariantsUpdate` |
| `inputProductosEliminar` | `ProductsWithVariantsDeleteLoaderInput` | Input listo para `ProductsWithVariantsDelete` |
| `productsToExcludeFromMarkets` | `PriceListsB2CLoaderInput` | **No conectada** — vestigio de lógica de mercados B2C |

---

## Configuración

```json title="appsettings.json"
"Workflows": {
  "Products": {
    "Name": "Productos",
    "Cron": null,
    "IncrementalCron": null,
    "Notifications": {
      "Recipients": []
    }
  }
}
```

Los productos se leen del canal `PIM:CanalSalida`. El Mirror lee de Shopify vía `ShopifyCredentials`.

---

## Documentos relacionados

| Documento | Descripción |
|---|---|
| [Detalle completo](wf-productos-detalle.md) | Actividades, lógica de decisión, ramas paralelas y casos especiales |
| [Métodos y funciones](wf-productos-metodos.md) | Código anotado de `ProductsWithImagesExtract` y `ProductsRebuildDecision` |
| [WF-06 — Imágenes Shopify](wf-imagenes-shopify.md) | Comparte `ProductsWithImagesExtract` |
| [Configuración — PIM](08-configuracion.md) | `PIM:CanalSalida` |
