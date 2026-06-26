---
tags:
  - Workflows
  - Procesos
  - Tarifas
  - B2B
  - Shopify
---

# WF-07 — Tarifas B2B

Las tarifas B2B (PriceLists de Shopify) no son un workflow independiente, sino una **responsabilidad distribuida** entre los workflows de Clientes y Productos. Esta página documenta los mecanismos disponibles en el código y cómo se integran.

---

## Índice

1. [Dónde viven las tarifas](#1-donde-viven-las-tarifas)
2. [SyncPriceLists — Mirror](#2-syncpricelists-mirror)
3. [Tarifa por defecto en Clientes](#3-tarifa-por-defecto-en-clientes)
4. [ExtractTarifas y PriceListTransform](#4-extracttarifas-y-pricelisttransform)
5. [Notas de estado](#5-notas-de-estado)

---

## 1. Dónde viven las tarifas

| Mecanismo | Workflow | Estado |
|---|---|---|
| `SyncPriceLists` (Mirror) | WF-03 Clientes | **Activo** |
| Asignación de tarifa por defecto a nuevas sucursales | WF-03 Clientes | **Activo** |
| `ExtractTarifas` + `PriceListTransform` | *(ninguno)* | **Inactivo** — clases implementadas pero sin workflow |

---

## 2. `SyncPriceLists` — Mirror

**Clase:** `SyncPriceLists` *(Loaders.Shopify.Mirror — proyecto externo)*

Sincroniza el estado de todas las PriceLists de Shopify en `TransactionsDB.PriceLists`. Se ejecuta como segunda actividad del **WF-03 Clientes**, antes de la extracción del ERP.

La sincronización permite que `CustomerTransform` conozca los ShopifyIds de las PriceLists existentes cuando va a asignar una tarifa a las nuevas sucursales.

---

## 3. Tarifa por defecto en Clientes

Cuando `CustomerTransform` crea nuevas sucursales (`createLocations`), asigna automáticamente la tarifa por defecto:

```csharp
var defaultPriceListId = _configuration["ShopifyCredentials:DefaultPriceListId"];

if (!string.IsNullOrWhiteSpace(defaultPriceListId) && !locationsOriginIds.IsNullOrDefault())
{
    priceListUpdateCompanyLocations = new Dictionary<string, string[]>
    {
        { defaultPriceListId, locationsOriginIds.ToArray() }
    };
}
```

Esta información se incluye en `CompaniesWithContactsInput.MarketsAndPriceListsToUpdate` y el loader la aplica como parte de la creación de sucursales.

**Configuración requerida:**

```json title="appsettings.json"
"ShopifyCredentials": {
  "DefaultPriceListId": "gid://shopify/PriceList/XXXXXXXX"
}
```

Si no está configurado, las nuevas sucursales no tendrán tarifa asignada automáticamente.

---

## 4. `ExtractTarifas` y `PriceListTransform`

Existen dos clases para una sincronización completa de tarifas desde el ERP:

| Clase | Fichero | Propósito |
|---|---|---|
| `ExtractTarifas` | `Extractors/PriceListExtract.cs` | Extrae tarifas del ERP vía `TransactionsService` |
| `PriceListTransform` | `Transformers/PriceListTransform.cs` | Transforma tarifas ERP → `PriceListsB2BLoaderInput` |

Sin embargo, **no existe un workflow que las use**. Las clases están implementadas pero no están conectadas a ningún flujo activo.

`PriceListTransform` maneja:
- Crear PriceLists nuevas con su moneda
- Actualizar precios de variantes por tarifa
- Excluir productos de tarifas
- Reset de precios de variantes no incluidas
- Reglas de cantidad (`QuantityRules`) y escalones de precio (`QuantityPriceBreaks`) — implementados pero comentados

---

## 5. Notas de estado

Las tarifas en Shopify B2B determinan los precios que ve cada empresa cliente. La arquitectura actual gestiona dos aspectos:

1. **Qué tarifa tiene cada sucursal** → gestionado en WF-03 Clientes (asignación por defecto en creación)
2. **Qué precios tiene cada tarifa** → infraestructura implementada (`ExtractTarifas` + `PriceListTransform`) pero sin workflow activo

El segundo punto requeriría añadir un workflow que use estas clases junto con un loader de PriceLists (`PriceListsB2BLoader`) del proyecto externo.
