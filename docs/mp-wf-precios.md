---
tags:
  - Marketplaces
  - Procesos
  - Precios
  - eWheel
  - ShoppingFeed
---

# Proceso — Precios (ERP → SF)

Actualiza los **precios** de ShoppingFeed con las tarifas vigentes del ERP eWheel. **Actualmente desactivado**: su registro como `HostedService` está comentado en `Program.cs`, aunque el código está completo.

!!! warning "Proceso desactivado"
    En `Program.cs`, dentro del bloque `#if RELEASE`, la línea
    `//services.AddHostedService<WorkerPricesSync>();` está comentada.
    El proceso no se ejecuta en ningún entorno hasta que se reactive.

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
| **Clase** | `WorkerPricesSync` |
| **Fichero** | `Workers/WorkerPricesSync.cs` |
| **Config key** | `WorkerPricesSync` |
| **Dirección** | ERP eWheel → ShoppingFeed |
| **Cron** | `0 10,13,16,22 * * *` (4 veces al día) |
| **Activo en RELEASE** | ❌ (comentado) |

---

## Grafo del proceso

=== ":material-chart-timeline-variant: Estático"

    ```mermaid
    flowchart LR
        ERP[("eWheel ERP\nTarifaPrecio")]
        SF[("ShoppingFeed")]

        GETP["GetPreciosProducto\nTarifas vigentes (empresa 3)"]
        GETI["GetFullInventoryAsync\nReferencias en SF"]
        FILTER["GetPricesToUpdate\nIntersección por SKU"]
        MAP["AutoMapper\nPrecioProducto → ProductPrice"]
        UPD["UpdateBulkPrices\nLotes de 100"]

        ERP -. "tarifas" .-> GETP
        SF -. "inventario" .-> GETI
        GETP --> FILTER
        GETI --> FILTER
        FILTER --> MAP --> UPD
        UPD -. "PUT pricing" .-> SF
    ```

---

## Pasos

| # | Acción | Detalle |
|---|---|---|
| 1 | Leer tarifas del ERP | `GetPreciosProducto(empresa=3)` → tarifas vigentes hoy, una por artículo |
| 2 | Leer inventario de SF | `GetFullInventoryAsync` → referencias publicadas |
| 3 | Filtrar | `GetPricesToUpdate`: solo precios cuyo SKU exista en SF (intersección) |
| 4 | Mapear | `PrecioProducto → ProductPrice` (AutoMapper) |
| 5 | Actualizar precios | `UpdateBulkPrices` por lotes de 100 |

> Igual que el proceso de stock, solo se actualizan en ShoppingFeed las referencias **ya publicadas** allí, cruzando por SKU.

---

## Variables del proceso

| Variable | Tipo | Descripción |
|---|---|---|
| `priceLists` | `List<PrecioProducto>` | Tarifas vigentes del ERP |
| `sfInventory` | `APIResponse<List<Inventory>>` | Referencias publicadas en SF |
| `pricesToUpdate` | `List<ProductPrice>` | Precios filtrados y mapeados a enviar |

---

## Configuración

```json title="appsettings.json"
"WorkerPricesSync": {
  "NumLimits": 1000,
  "Name": "WorkerPricesSync",
  "Description": "Actualizar precios en ShoppingFeed con los datos recuperados de SAP.",
  "Cron": "0 10,13,16,22 * * *"
}
```

---

## Métodos

| Método | Propósito |
|---|---|
| `DoWork` | Obtiene tarifas del ERP y lanza el procesamiento de la tienda |
| `ProcessStorePriceListsAsync` | Pipeline: inventario SF → filtrar → actualizar |
| `RetrieveSFInventoryAsync` | Envuelve `GetFullInventoryAsync` |
| `GetPricesToUpdate` | Intersección por SKU y mapeo a `ProductPrice` |
| `UpdatePricesInShoppingFeed` | Envuelve `UpdateBulkPrices`, lanza excepción si falla |

```csharp title="Filtrado por SKU (GetPricesToUpdate)"
var sfRefs = sfInventory.Data.Select(inv => inv.ProductReference).ToList();
var filtered = productPrices.Where(pp => sfRefs.Contains(pp.SKU)).ToList();
return filtered.Select(x => mapper.Map<ProductPrice>(x)).ToList();
```

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [eWheel](mp-ewheel.md) | `GetPreciosProducto` y la tabla `TarifaPrecio` |
| [ShoppingFeed](mp-shoppingfeed.md) | `UpdateBulkPrices` y paginación |
| [Modelos de datos](mp-modelos.md) | `TarifaPrecio`, `PrecioProducto`, `ProductPrice` |
| [Arquitectura del conector](mp-arquitectura.md#registro-y-activacion-de-workers) | Por qué está desactivado |
