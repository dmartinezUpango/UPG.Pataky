---
tags:
  - Workflows
  - Procesos
  - Pedidos
  - Shopify
  - ERP
---

# WF-04 — Pedidos

Envío de pedidos B2B desde Shopify al ERP (Provalliance). Este workflow es el único del sistema con **dirección inversa**: extrae pedidos pendientes de Shopify, los transforma al formato del ERP, los envía al middleware y finalmente etiqueta los pedidos procesados en Shopify con una tag de sincronización.

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
| **Clase** | `OrdersWorkflow` |
| **Fichero** | `ElsaServer/Workflows/OrdersWorkflow.cs` |
| **Config key** | `Workflows:Orders` |
| **Dirección** | Shopify → ERP (Provalliance) ← **inversa** |
| **Trigger** | `PublishEvent("Carga de pedidos Shopify-ERP")` |
| **Cron** | `null` — solo ejecución manual desde Elsa Studio |
| **Incremental** | No — filtra por tag de sincronización |
| **Mirror** | No |

---

## Grafo del workflow

=== ":material-graph: Interactivo"

    <div id="reactflow-root"></div>

    <div id="reactflow-data" style="display:none">
    {
      "height": 320,
      "nodes": [
        {"id":"shopify_src",  "type":"input",  "data":{"label":"Shopify Pedidos B2B"},  "position":{"x":0,   "y":80}},
        {"id":"ex",                            "data":{"label":"OrdersExtractor"},       "position":{"x":220, "y":80}},
        {"id":"tr",                            "data":{"label":"OrderTransform"},        "position":{"x":430, "y":80}},
        {"id":"ld",                            "data":{"label":"LoadOrders"},            "position":{"x":640, "y":80}},
        {"id":"upd",                           "data":{"label":"OrdersLoader"},          "position":{"x":850, "y":80}},
        {"id":"erp",          "type":"output", "data":{"label":"ERP Provalliance"},      "position":{"x":640, "y":240}},
        {"id":"shopify_dst",  "type":"output", "data":{"label":"Shopify (addTags)"},     "position":{"x":850, "y":240}}
      ],
      "edges": [
        {"id":"e1","source":"shopify_src","target":"ex",          "label":"bulk query",        "animated":true},
        {"id":"e2","source":"ex",         "target":"tr",          "label":"Box<Order>"},
        {"id":"e3","source":"tr",         "target":"ld",          "label":"Box<OrderModel>"},
        {"id":"e4","source":"ld",         "target":"erp",         "label":"PostOrder()",       "animated":true},
        {"id":"e5","source":"ld",         "target":"upd",         "label":"OrdersLoaderInput"},
        {"id":"e6","source":"upd",        "target":"shopify_dst", "label":"addTags",           "animated":true}
      ]
    }
    </div>

=== ":material-chart-timeline-variant: Estático"

    ```mermaid
    flowchart LR
        SHOPIFY[("Shopify\nPedidos B2B")]
        EX["OrdersExtractor\nBulk query GraphQL\ntag_not:Sincronizado"]
        TR["OrderTransform\nMapea Order → OrderModel\nFiltra sin externalId"]
        LD["LoadOrders\nEnvía cada pedido al ERP\nRegistra en TransactionsDB\nPrepara tags a añadir"]
        UPD["OrdersLoader\nAñade tag 'Sincronizado'\nen Shopify para cada pedido"]
        ERP[("ERP Middleware\nProvalliance")]

        SHOPIFY -. "bulk query" .-> EX
        EX -->|"Box&lt;Order&gt; pedidosShopify"| TR
        TR -->|"Box&lt;OrderModel&gt; pedidos"| LD
        LD -. "PostOrder()" .-> ERP
        LD -->|"OrdersLoaderInput inputLoader"| UPD
        UPD -. "addTags" .-> SHOPIFY
    ```

---

## Actividades

| # | Clave interna | Clase | Tipo | Propósito |
|---|---|---|---|---|
| 1 | `extractOrders` | `OrdersExtractor` *(Loaders)* | Extractor | Bulk query de pedidos sin tag de sincronización |
| 2 | `transformPedidos` | `OrderTransform` | Transformer | Mapea pedidos Shopify al formato del ERP |
| 3 | `loadPedidosERP` | `LoadOrders` | Transformer + Loader | Envía pedidos al ERP y prepara tags de Shopify |
| 4 | `updatePedidosShopify` | `OrdersLoader` *(Loaders)* | Loader | Etiqueta los pedidos procesados en Shopify |

> **Nota:** `LoadOrders` actúa como transformer-loader porque envía al ERP (efecto) y produce el input para `OrdersLoader` (salida hacia siguiente actividad).

---

## Variables del workflow

| Variable | Tipo | Descripción |
|---|---|---|
| `pedidosShopify` | `Box<Order>` | Pedidos brutos de Shopify sin procesar |
| `pedidos` | `Box<OrderModel>` | Pedidos transformados con cabecera y líneas para el ERP |
| `inputLoader` | `OrdersLoaderInput` | Mapa de `orderId → tags` a añadir en Shopify |

---

## Configuración

```json title="appsettings.json"
"FilterOrders": {
  "query": "tag_not:Sincronizado"
},
"Workflows": {
  "Orders": {
    "Name": "Pedidos",
    "Cron": null,
    "IncrementalCron": null,
    "Notifications": {
      "Recipients": []
    }
  }
}
```

La tag `Sincronizado` se lee de `FilterOrders:query` (prefijo `tag_not:`). Si no está configurado, se usa `"Sincronizado"` como valor por defecto.

---

## Documentos relacionados

| Documento | Descripción |
|---|---|
| [Detalle completo](wf-pedidos-detalle.md) | Actividades, modelos de pedido y mecanismo de idempotencia |
| [Métodos y funciones](wf-pedidos-metodos.md) | Código anotado de `OrderTransform` y `LoadOrders` |
| [Configuración](08-configuracion.md) | `FilterOrders` y `Workflows:Orders` |
| [Modelos de datos](06-modelos.md) | Modelos `OrderModel`, `OrderHeaderModel`, `OrderLineModel` |
