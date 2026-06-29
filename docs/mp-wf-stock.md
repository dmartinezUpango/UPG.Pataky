---
tags:
  - Marketplaces
  - Procesos
  - Stock
  - eWheel
  - ShoppingFeed
---

# Proceso — Stock (ERP → SF)

Actualiza el **stock disponible** de cada referencia publicada en ShoppingFeed con el dato real del ERP eWheel. Es el proceso más sencillo y el más frecuente.

---

## Índice

1. [Resumen](#resumen)
2. [Grafo del proceso](#grafo-del-proceso)
3. [Pasos](#pasos)
4. [Variables del proceso](#variables-del-proceso)
5. [Configuración](#configuracion)
6. [Métodos](#metodos)
7. [Documentos relacionados](#documentos-relacionados)

---

## Resumen

| Campo | Valor |
|---|---|
| **Clase** | `WorkerStockSync` |
| **Fichero** | `Workers/WorkerStockSync.cs` |
| **Config key** | `WorkerStockSync` |
| **Dirección** | ERP eWheel → ShoppingFeed |
| **Cron** | `15/15 * * * *` (cada 15 min, en min 15/30/45/00) |
| **Activo en RELEASE** | ✅ |

---

## Grafo del proceso

=== ":material-chart-timeline-variant: Estático"

    ```mermaid
    flowchart LR
        SF[("ShoppingFeed\nInventario")]
        ERP[("eWheel ERP\nVIS_TEES_StockDisponible")]

        GET["GetFullInventoryAsync\nLista de referencias en SF"]
        LOOP["Por cada referencia:\nGetStockByCodigoArticulo"]
        NORM["SetNegativeStockToZero\nStock < 0 → 0"]
        MAP["AutoMapper\nProductoConStock → Inventory"]
        UPD["UpdateBulkInventory\nLotes de 100"]

        SF -. "inventario" .-> GET
        GET --> LOOP
        ERP -. "stock" .-> LOOP
        LOOP --> NORM --> MAP --> UPD
        UPD -. "PUT inventory" .-> SF
    ```

---

## Pasos

| # | Acción | Servicio | Detalle |
|---|---|---|---|
| 1 | Autenticar en ERP | `IEwheelService.InitializeAuthentication` | Si falla, el proceso no continúa |
| 2 | Leer inventario de SF | `IFeedService.GetFullInventoryAsync` | Devuelve todas las referencias publicadas |
| 3 | Obtener stock por referencia | `IEwheelService.GetStockByCodigoArticulo` | Consulta `VIS_TEES_StockDisponible` |
| 4 | Normalizar negativos | `SetNegativeStockToZero` | Stock < 0 se fuerza a 0 |
| 5 | Mapear a `Inventory` | AutoMapper | `ProductoConStock → Inventory` |
| 6 | Actualizar stock en SF | `IFeedService.UpdateBulkInventory` | Por lotes de 100 |

> El stock se toma como **fuente de verdad del ERP**: solo se actualizan en ShoppingFeed las referencias que ya existen allí (se itera sobre el inventario de SF, no sobre todo el catálogo del ERP).

---

## Variables del proceso

| Variable | Tipo | Descripción |
|---|---|---|
| `sfInventory` | `List<Inventory>` | Referencias publicadas en ShoppingFeed |
| `productosConStock` | `List<ProductoConStock>` | Cada SKU con su stock leído del ERP |
| `inventoryToUpdate` | `List<Inventory>` | Resultado mapeado, listo para enviar a SF |

---

## Configuración

```json title="appsettings.json"
"WorkerStockSync": {
  "NumLimits": 1000,
  "Name": "WorkerStockSync",
  "Description": "Actualización del stock de los productos subidos en ShoppingFeed.",
  "Cron": "15/15 * * * *",
  "EnableErrorRecovery": false
}
```

El `StoreId` se lee de `ShoppingFeedServiceSettings`.

---

## Métodos

| Método | Propósito |
|---|---|
| `DoWork` | Orquesta: autentica, obtiene el store y llama a `ProcessStoreAsync` |
| `ProcessStoreAsync` | El pipeline completo de los 6 pasos |
| `RetrieveSFInventoryAsync` | Envuelve `GetFullInventoryAsync` con logging |
| `SetNegativeStockToZero` | Normaliza stock negativo a 0 |
| `UpdateShoppingFeedInventoryAsync` | Envuelve `UpdateBulkInventory` y lanza excepción si falla |

```csharp title="Núcleo de ProcessStoreAsync"
var sfInventory = (await RetrieveSFInventoryAsync(feedService, store)).Data;
var productosConStock = new List<ProductoConStock>();

foreach (var item in sfInventory)
{
    if (string.IsNullOrWhiteSpace(item.ProductReference)) continue;
    var stock = await ewheelService.GetStockByCodigoArticulo(item.ProductReference);
    productosConStock.Add(new ProductoConStock { SKU = item.ProductReference, Stock = stock });
}

SetNegativeStockToZero(productosConStock);
var inventoryToUpdate = mapper.Map<List<Inventory>>(productosConStock);
await UpdateShoppingFeedInventoryAsync(feedService, inventoryToUpdate, store);
```

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [eWheel](mp-ewheel.md) | `GetStockByCodigoArticulo` y la vista `VIS_TEES_StockDisponible` |
| [ShoppingFeed](mp-shoppingfeed.md) | `GetFullInventoryAsync` y `UpdateBulkInventory` |
| [Modelos de datos](mp-modelos.md) | `Inventory`, `ProductoConStock` |
| [Mapeo y transformación](mp-mapeo.md) | `ProductoConStock → Inventory` |
