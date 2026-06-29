---
tags:
  - Workflows
  - Procesos
  - Stock
  - ERP
  - Shopify
---

# WF-02 — Stock

Actualización de niveles de inventario desde el ERP (Provalliance) hacia Shopify. El workflow extrae el stock de todas las variantes del middleware, lo cruza con la tabla de correspondencias `TransactionsDB` para obtener los IDs de Shopify, y actualiza los niveles de inventario. Las variantes presentes en la base de datos pero ausentes en la extracción se ponen a `0`.

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
| **Clase** | `StockWorkflow` |
| **Fichero** | `ElsaServer/Workflows/StockWorkflow.cs` |
| **Config key** | `Workflows:Stock` |
| **Dirección** | ERP (Provalliance) → Shopify |
| **Trigger** | `PublishEvent("Stock")` |
| **Cron** | `null` — solo ejecución manual desde Elsa Studio |
| **Incremental** | No |
| **Mirror** | No |

---

## Grafo del workflow

=== ":material-graph: Interactivo"

    <div id="reactflow-root"></div>

    <div id="reactflow-data" style="display:none">
    {
      "nodes": [
        {"id":"erp",       "type":"input",  "data":{"label":"ERP Provalliance"},  "position":{"x":0,   "y":80}},
        {"id":"extract",                    "data":{"label":"StockExtract","url":"../wf-stock-metodos/#1-stockextract-clase"},       "position":{"x":200, "y":80}},
        {"id":"transform",                  "data":{"label":"StockTransform","url":"../wf-stock-metodos/#3-stocktransform-clase"},     "position":{"x":400, "y":80}},
        {"id":"loader",                     "data":{"label":"SyncStock"},          "position":{"x":600, "y":80}},
        {"id":"shopify",   "type":"output", "data":{"label":"Shopify Inventory"},  "position":{"x":800, "y":80}}
      ],
      "edges": [
        {"id":"e1","source":"erp",       "target":"extract",   "label":"GetStock()",             "animated":true},
        {"id":"e2","source":"extract",   "target":"transform", "label":"Box<Stock>"},
        {"id":"e3","source":"transform", "target":"loader",    "label":"SyncStockInput"},
        {"id":"e4","source":"loader",    "target":"shopify",   "label":"InventorySetQuantities", "animated":true}
      ]
    }
    </div>

=== ":material-chart-timeline-variant: Estático"

    ```mermaid
    flowchart LR
        ERP[("ERP Middleware\nProvalliance")]
        EX["StockExtract\nLlama a ProvallianceService\nDevuelve EAN + Warehouse + Quantity"]
        TR["StockTransform\nCruza EAN con TransactionsDB\nPone a 0 las variantes ausentes"]
        LD["SyncStock\nActualiza inventario\nvía Shopify API"]
        SHOPIFY[("Shopify\nInventory")]

        ERP -. "GetStock()" .-> EX
        EX -->|"Box&lt;Stock&gt; extractedStock"| TR
        TR -->|"SyncStockInput transformedStock"| LD
        LD -. "InventorySetQuantities" .-> SHOPIFY
    ```

---

## Actividades

| # | Clave interna | Clase | Tipo | Propósito |
|---|---|---|---|---|
| 1 | `extraccion` | `StockExtract` | Extractor | Lee el stock de todas las variantes del middleware |
| 2 | `transformacion` | `StockTransform` | Transformer | Mapea EAN → IDs Shopify, pone a 0 las ausentes |
| 3 | `carga` | `SyncStock` *(Loaders)* | Loader | Actualiza los niveles de inventario en Shopify |

---

## Variables del workflow

| Variable | Tipo | Descripción |
|---|---|---|
| `extractedStock` | `Box<Stock>` | Lista de registros EAN + almacén + cantidad del ERP |
| `transformedStock` | `SyncStockInput` | Mapa de variantes Shopify → actualizaciones de stock, listo para cargar |

---

## Configuración

```json title="appsettings.json"
"Workflows": {
  "Stock": {
    "Name": "Stock",
    "Cron": null,
    "IncrementalCron": null,
    "Notifications": {
      "Recipients": []
    }
  }
}
```

El stock ERP se obtiene vía `ProvallianceService`. La ubicación de inventario de Shopify se lee de `ShopifyCredentials:LocationId`.

---

## Documentos relacionados

| Documento | Descripción |
|---|---|
| [Detalle completo](wf-stock-detalle.md) | Actividades, modelo Stock y lógica de cero-stock |
| [Métodos y funciones](wf-stock-metodos.md) | Código anotado de `StockExtract` y `StockTransform` |
| [Configuración — Shopify](08-configuracion.md) | `ShopifyCredentials:LocationId` |
| [Modelos de datos](06-modelos.md) | Modelo `Stock` |
