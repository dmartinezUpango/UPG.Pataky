---
tags:
  - Loaders
  - Mirror
  - Shopify
---

# 10b — Loaders y Mirror: detalle completo

> **¿Buscas la descripción general de cada loader?**
> → [`10-loaders.md`](10-loaders.md) — qué hace cada loader y su secuencia de sub-operaciones a alto nivel.
>
> **¿Quieres ver el código fuente de los métodos más complejos?**
> → [`10c-loaders-metodos.md`](10c-loaders-metodos.md) — implementación paso a paso con anotaciones.

---

## El contrato de todos los loaders

Todos los loaders implementan `BaseActivity<T>` e `IActivityInput`. El patrón es siempre el mismo:

```csharp
protected override bool ShouldRunAsync() => _input.RunActivity;
```

La propiedad `RunActivity` del modelo de input comprueba si hay alguna sub-operación activa. Si todas las listas de entrada están vacías o los flags son `false`, el loader salta sin hacer ninguna llamada.

Todas las sub-operaciones están protegidas por `BrakeGuard()` entre sí. Si el freno está activado (`WorkflowsBrakeService`), la ejecución lanza una excepción y el workflow queda suspendido hasta que el freno se libere manualmente.

---

## 1. ProductsWithVariantsCreate

**Fichero:** `Loaders/Shopify/Products/ProductsWithVariantsCreate.cs`
**Input:** `ProductsWithVariantsCreateLoaderInput`

### Campos del modelo de input

| Campo | Tipo | Descripción |
|---|---|---|
| `Products` | `List<(OriginInput<ProductCreateInput>, OriginInput<ProductVariantsBulkInput>[])>` | Productos a crear con sus variantes. Cada producto lleva su lista de variantes. |
| `ExcludeNewProductsFromMarkets` | `bool` (default `true`) | Si `true`, excluye los productos recién creados de todos los mercados. |
| `PublishProducts` | `bool` (default `false`) | Si `true`, publica **todos** los productos de la BD en el canal configurado en `ShopifyCredentials:PublicationId`. |
| `Variants` | `Dictionary<ShopifyId, OriginInput<ProductVariantsBulkInput>[]>` | Variantes a añadir a productos ya existentes (sin crear el producto padre). |

`RunActivity` devuelve `true` si hay productos, variantes o `PublishProducts = true`.

### Sub-operaciones y referencias

| Sub-operación | Descripción |
|---|---|
| `ProcessProducts` → `CreateProductsAndVariants()` | Los 5 pasos encadenados: crear → excluir mercados → crear variantes → borrar `$` → reordenar opciones. Ver → [`CreateProductsAndVariants`](10c-loaders-metodos.md#1-productswithvariantscreate-createproductsandvariants) |
| `ProcessProductOptionsToCreate` | **Obsoleto.** Usar `RebuildProductOptions` de `ProductsWithVariantsUpdate`. |
| `ProcessVariants` | Añade variantes a productos ya existentes. SKU obligatorio. |
| `PublishProducts` | Publica todos los productos de la BD en el canal `PublicationId`. Solo se activa si `PublishProducts = true`. |

### Validación previa

El modelo lanza excepción si algún producto de `Products` llega con cero variantes:

```csharp
if (Products is not null && Products.Any(x => x.variants.Length == 0))
    throw new ArgumentException("Todos los productos deben tener al menos una variante.");
```

---

## 2. ProductsWithVariantsUpdate

**Fichero:** `Loaders/Shopify/Products/ProductsWithVariantsUpdate.cs`
**Input:** `ProductsWithVariantsUpdateLoaderInput`

### Campos del modelo de input

| Campo | Tipo | Descripción |
|---|---|---|
| `Products` | `List<OriginInput<ProductUpdateInput>>` | Productos a actualizar. Se usa `BulkUpdate`. Los metafields con valor nulo se borran explícitamente. |
| `RebuildProductOptions` | `Dictionary<ShopifyId, OriginInput<ProductVariantsBulkInput>[]>` | Productos cuyo esquema de opciones cambió. Clave = ShopifyId del producto. |
| `ProductOptionsAndValuesToReorder` | `Dictionary<ShopifyId, Dictionary<ShopifyId, List<string>>>` | Reordenación de opciones. Clave externa = producto, clave interna = opción, valor = lista ordenada de nombres de valor. |
| `Variants` | `Dictionary<ShopifyId, OriginInput<ProductVariantsBulkInput>[]>` | Variantes a actualizar. Los metafields nulos se borran. |
| `InventoryItems` | `Dictionary<OriginId, InventoryItemInput>` | InventoryItems a actualizar por OriginId de variante o por InventoryItemId directo. |

`RunActivity` devuelve `true` si cualquiera de las listas tiene elementos.

### Sub-operaciones y referencias

| Sub-operación | Descripción |
|---|---|
| `ProcessProducts` → `UpdateProducts()` | `BulkUpdate` de productos. Detecta y borra metafields con valor nulo. |
| `ProcessRebuildProductOptions` → `RebuildProductOptions()` | Migración completa de opciones con variante centinela. Ver → [`RebuildProductOptions`](10c-loaders-metodos.md#2-productswithvariantsupdate-rebuildproductoptions) |
| `ProcessProductOptionsAndValuesToReorder` → `ReorderOptions()` | Cambia el orden de las opciones y sus valores. Método estático reutilizable desde otros loaders. |
| `ProcessVariants` → `UpdateVariants()` | `BulkUpdate` de variantes. Detecta y borra metafields nulos. |
| `ProcessInventoryItems` → `UpdateInventoryItems()` | Actualiza `InventoryItem` (Sku, tracking). Busca el `ShopifyInventoryItemId` en BD. |

### Comportamiento ante metafields nulos

Tanto `UpdateProducts` como `UpdateVariants` detectan los metafields con valor nulo o vacío y los borran explícitamente con `Metafields.Delete()`. La razón: Shopify rechaza `metafieldsSet` con valor vacío, pero tampoco los borra automáticamente si no se envían — hay que borrarlos de forma explícita.

---

## 3. ProductsWithVariantsDelete

**Fichero:** `Loaders/Shopify/Products/ProductsWithVariantsDelete.cs`
**Input:** `ProductsWithVariantsDeleteLoaderInput`

### Campos del modelo de input

| Campo | Tipo | Descripción |
|---|---|---|
| `VariantsToDelete` | `Dictionary<ShopifyId, ShopifyId[]>` | Clave = ShopifyId del producto padre, valor = ShopifyIds de variantes a borrar. |
| `ProductsToDelete` | `List<ShopifyId>` | ShopifyIds de productos a borrar completos. |

`RunActivity` devuelve `true` si hay variantes o productos a borrar.

### Sub-operaciones y referencias

| Sub-operación | Descripción |
|---|---|
| `RemoveProductsIfLastVariants()` | Pre-check que promueve el borrado de variante a borrado de producto si son las únicas. Se ejecuta antes de cualquier otra sub-operación. Ver → [`RemoveProductsIfLastVariants`](10c-loaders-metodos.md#3-productswithvariantsdelete-removeproductsiflastvariants) |
| `ProcessVariantsToDelete` → `DeleteVariants()` | `BulkDelete` de variantes agrupadas por producto. |
| `ProcessProductsToDelete` → `DeleteProducts()` | Borrado individual de productos con `Products.Delete()`. |

---

## 4. PriceListsB2B

**Fichero:** `Loaders/Shopify/Products/PriceListsB2B.cs`
**Input:** `PriceListsB2BLoaderInput`

### Modelo de datos en Shopify

Shopify B2B estructura las tarifas en tres objetos relacionados:

```text
Catalog (agrupa productos visibles para esa tarifa)
  ├── PriceList  (moneda y precios fijos por variante)
  └── Publication (permite publicar/despublicar productos en esa tarifa)
```

Al crear una tarifa se crean los tres. Al borrar, se borra solo el `Catalog` y Shopify elimina los otros en cascada.

### Sub-operaciones (en orden)

| # | Sub-operación | Descripción |
|---|---|---|
| 1 | `ProcessPriceListsToDelete` | Borrar catálogos (con cascade). Usa BD para obtener `CatalogId` a partir del `PriceListId`. |
| 2 | `ProcessPriceListsToCreate` | Crear Catalog → Publication → PriceList en secuencia. En paralelo entre tarifas. |
| 3 | `ProcessSetProductVariantsFixedPrices` | Asignar precios fijos a variantes en una tarifa. Resuelve OriginIds de PriceLists antes de llamar al SDK. |
| 4 | `ProcessResetProductVariantsFixedPrices` | Quitar el precio fijo (volver al precio base calculado por porcentaje). |
| 5 | `ProcessExcludeProducts` | Despublicar un producto de la Publication de un catálogo. |
| 6 | `ProcessQuantityPricesRules` | Crear o borrar `QuantityRules` (mínimo/máximo/múltiplo) y `QuantityPriceBreaks` (precio por volumen). Los borrados van ANTES que los creates en llamadas separadas. |

### Validación en QuantityPriceBreaks

Antes de crear un `QuantityPriceBreak`, el loader verifica que respeta la `QuantityRule` de su variante. Si la regla dice mínimo 5 unidades y el break está definido para 3, se descarta con `LogWarning`. Esta validación evita errores de la API de Shopify que de otro modo serían silenciosos.

---

## 5. ProductsMedias

**Fichero:** `Loaders/Shopify/Products/ProductsMedias.cs`
**Input:** `ProductsMediasLoaderInput`

### Sub-operaciones

| Sub-operación | Descripción |
|---|---|
| `ProcessDeleteMedias` | Borra medios por ShopifyId. Registra borrado en BD. |
| `ProcessCreateMedias` | Sube imágenes (por URL o por binario). Guarda `OriginId` en el campo `ALT` para que `SyncProductMedias` pueda recuperarlo. Si tienen `Position`, las reordena tras subir. |
| `ProcessUpdateMedias` | Actualiza `ALT` o `Url` de imágenes existentes. Recupera el `OriginId` de la BD antes de sobrescribir el `ALT`. Omite videos externos (no admiten cambio de URL). |
| `ProcessAppendFiles` | Asocia ficheros de la biblioteca de Shopify a un producto usando `ProductSetInput`. |
| `ProcessDetachMedias` | Desasocia imágenes de variantes específicas. En lotes de 100. |
| `ProcessAppendMedias` | Asocia imágenes ya subidas a variantes concretas. Solo 1 imagen por variante. En lotes de 100. |
| `PublishProductsWithMedias` | Publica todos los productos de la BD que tengan al menos una imagen. |

**Por qué el `OriginId` se guarda en el campo `ALT`:** el campo `ALT` es el único campo de texto libre de una media en Shopify que se puede leer y escribir sin restricciones. El Mirror `SyncProductMedias` lo lee para saber qué `OriginId` corresponde a cada imagen al reconciliar el estado de Shopify con la BD.

---

## 6. SyncStock

**Fichero:** `Loaders/Shopify/Stock/SyncStock.cs`
**Input:** `SyncStockInput`

### Fases

**Fase 1 — UpdateVariants**

Actualiza `InventoryPolicy` (si se puede vender sin stock) y metafields de variantes. Solo procesa las variantes donde al menos uno de estos campos tiene valor. Elimina metafields nulos explícitamente.

**Fase 2 — InventorySetQuantities**

Establece cantidades de stock exactas mediante la mutación `inventorySetQuantities` de Shopify:
- Trabaja en **lotes de 250** (límite de la API)
- `IgnoreCompareQuantity = true` → el valor se establece directamente sin comparar con la cantidad anterior
- Busca el `InventoryItemId` en la BD con `FindInventoryItemsIds`. Si no lo encuentra, descarta la variante con `LogWarning`
- El `InventoryItemId` es distinto del `VariantId` — es el identificador del ítem de inventario en Shopify, que la BD almacena en `Variant.ShopifyInventoryItemId`

---

## 7. CompaniesWithContactsLoader

**Fichero:** `Loaders/Shopify/Companies/CompaniesWithContactsLoader.cs`
**Input:** `CompaniesWithContactsInput`

### Orden de las 17 sub-operaciones

El orden es crítico: siempre se borra antes de crear, y las entidades padre antes que las hijas.

| # | Sub-operación | Método | Descripción |
|---|---|---|---|
| 1 | `ProcessRevokeRoles` | `RevokeRoles()` | Desasigna roles de contactos. En paralelo. |
| 2 | `ProcessDeleteContacts` | `DeleteContacts()` | Borra contactos. Los marcados `IsAgent = true` se omiten aunque estén en la lista. |
| 3 | `ProcessDeleteLocations` | `DeleteLocations()` | Borra sucursales con `Locations.Delete()`. |
| 4 | `ProcessDeleteCompanies` | `DeleteCompanies()` | Desasocia contactos primero, luego borra en lotes de 50. Ver → [`DeleteCompanies`](10c-loaders-metodos.md#deletecompanies-y-removecontactsfromcompanies) |
| 5 | `ProcessCreateCompanies` | `CreateCompanies()` | Crea company + primera location + contactos + MainContact. En paralelo. Ver → [`CreateCompanies`](10c-loaders-metodos.md#4-companieswithcontactsloader-createcompanies) |
| 6 | `ProcessUpdateCompanies` | `UpdateCompanies()` | Actualiza nombre y `ExternalId` de companies. En paralelo. |
| 7 | `ProcessCreateLocations` | `CreateLocations()` | Añade locations a companies existentes. En paralelo. |
| 8 | `ProcessUpdateLocations` | `UpdateLocations()` | Actualiza nombre y `ExternalId` de locations. En paralelo. |
| 9 | `ProcessUpdateCompanyLocationsTaxSettings` | `UpdateCompanyLocationsTaxSettings()` | Actualiza exenciones fiscales y número de registro fiscal. En paralelo. |
| 10 | `ProcessUpdateLocationAddresses` | `UpdatelocationAddresses()` | Actualiza direcciones de envío y/o facturación. Si billing = shipping, usa una sola llamada. En paralelo. |
| 11 | `ProcessCreateContacts` | `CreateContacts()` | Crea contactos. Si el customer ya existe en Shopify (por email), lo asocia con `CompanyAssignCustomerAsContact` en lugar de crear uno nuevo. |
| 12 | `ProcessUpdateContacts` | `UpdateContacts()` | Actualiza email y nombre. En paralelo. |
| 13 | `ProcessAddCustomersTags` | `AddCustomersTags()` | Añade etiquetas a customers. Solo añade las que faltan; no borra las existentes. |
| 14 | `ProcessMainContactsToAssign` | `AssignMainContacts()` | Asigna el contacto principal de cada empresa. |
| 15 | `ProcessCreateMetafields` | `CreateMetafields()` | Crea/actualiza metafields. Borra los nulos. En lotes de 25. Ver → [`CreateMetafields`](10c-loaders-metodos.md#5-companieswithcontactsloader-createmetafields) |
| 16 | `ProcessMarketsAndPriceListsToUpdate` | `PriceListsUpdateLocations()` + `MarketsUpdateLocations()` | Actualiza qué locations pertenecen a cada tarifa y/o mercado. En lotes de 250. |
| 17 | `ProcessAssignRoles` | `AssignRoles()` | Asigna roles de acceso a contactos en sucursales. |

### Gestión del contacto principal (sub-op 14)

`AssignMainContacts` recibe pares `(shopifyCompanyId, originIdContact)`. El método resuelve el `originIdContact` a su `ShopifyId` consultando la BD antes de llamar a `Companies.Contacts.AssignMainContact()`. Si el contacto no tiene `ShopifyId` en BD (no fue creado correctamente), se registra un error y se omite.

### Actualización de locations en tarifas y mercados (sub-op 16)

El método genérico `UpdateShopifyLocations()` se usa tanto para catálogos como para markets. Calcula:
- `locationsToAdd` = locations deseadas que no están en el estado actual de Shopify
- `locationsToRemove` = locations que están en Shopify pero no en el estado deseado (solo si `MarketsAndPriceListsRemoveMissingLocations = true`)

Las actualizaciones se procesan en lotes de 250 para no superar los límites de la API.

---

## 8. OrdersLoader

**Fichero:** `Loaders/Shopify/Orders/OrdersLoader.cs`
**Input:** `OrdersLoaderInput`

Este loader no crea datos en Shopify a partir del ERP. Gestiona el **estado de los pedidos** de Shopify después de que el ERP los procesó.

### Sub-operaciones

| Sub-operación | Descripción |
|---|---|
| `ProcessAddTags` | Añade etiquetas a pedidos (p.ej., `"Sincronizado"`) usando `TagsAdd`. |
| `ProcessCreateManualPayments` | Registra un pago manual en un pedido para reflejar pagos procesados fuera de Shopify. |
| `ProcessordersToCancel` | Cancela pedidos. Configurable: motivo, restock automático, notificación al cliente. |
| `ProcessOrdersToMarkAsPaid` | Marca pedidos como pagados con `MarkOrderAsPaid()`. |
| `ProcessFulfillmentsCreate` | Crea fulfillments (envíos). Requiere recuperar el `FulfillmentOrderId` del pedido antes de llamar a la API. |
| `ProcessFulfillmentEventsCreate` | Crea eventos de fulfillment (estados: en tránsito, entregado, etc.). Requiere el `FulfillmentId` del pedido. |

---

## Las actividades Mirror en detalle

### SyncProducts (v1) y SyncProductsV2

Ambas versiones leen todos los productos de Shopify mediante una query bulk (`BulkGetAllWithVariantsExtended` vs `BulkGetAllWithMetafieldKeyFilter`) y reconcilian la BD.

**Diferencia clave de rendimiento:**

| Aspecto | SyncProducts (v1) | SyncProductsV2 (v2, actual) |
|---|---|---|
| Descarga | Stream completo sin filtros | Filtra por clave de metafield antes de descargar |
| Consultas a BD | Una por elemento durante el procesamiento | Carga toda la BD en 6 diccionarios en memoria al inicio |
| SaveChanges | Por cada elemento o grupo | Solo al final de productos y al final de variantes |

**El campo `OriginId` en Shopify:** ambas versiones leen el `OriginId` de cada producto/variante del metafield cuya clave está configurada en `Mirror:Metafield_Name_OriginId` (default: `"originId"`).

**Gestión de duplicados de `OriginId`:** si dos productos/variantes en Shopify tienen el mismo `OriginId`, el Mirror les asigna GUIDs aleatorios como `OriginId` para invaliarlos. De este modo el Decision no puede clasificarlos como actualizaciones válidas y los tratará como elementos nuevos en el próximo ciclo.

**`SyncProductsV2` — lógica Claim:** si el `DestinoId` de un producto ya existente en BD cambió en Shopify (el producto fue recreado), la v2 detecta la inconsistencia comparando `productsByDestinoId` vs `productsByOrigenId` y actualiza el `DestinoId` en lugar de crear un registro duplicado.

### SyncProductMedias

Lee los productos con sus variantes e imágenes de Shopify y reconcilia la tabla de medias en BD. La singularidad de este Mirror es que en el stream bulk de Shopify cada imagen aparece **dos veces**:
1. Como objeto `Media` (con su `Id` y `ALT`)
2. Como asignación variante-imagen (con el `Id` de la variante en el campo `MimeType`)

El código fusiona estos pares para reconstruir qué imagen está asignada a qué variante. El `OriginId` de la imagen se extrae del campo `ALT` (donde `ProcessCreateMedias` lo guardó al subir la imagen).

### SyncPriceLists

Descarga todas las `PriceList` de Shopify y sincroniza la tabla `PriceListsVariants`:
- **Añade** variantes que están en Shopify pero no en BD
- **Elimina** variantes que están en BD pero ya no en Shopify
- **No almacena el precio real**: guarda importe `0`. La lógica de precios la gestiona el workflow de Productos, no el Mirror.

### SyncCompanies

El Mirror más completo. 7 fases que upsertean companies, contacts, locations, roles, agents y customers sin empresa. Ver → [SyncCompanies RunAsync y sus fases](10c-loaders-metodos.md#6-synccompanies-runasync-y-fases).

### MirrorMediasLoad

A diferencia de `SyncProductMedias` (que solo mira Shopify), `MirrorMediasLoad` cruza el estado de Shopify con la información del PIM para construir el mapping imagen↔variante. Recibe como input una lista de `ProductImagesMirror` (la asignación imagen→variante según el PIM) y la usa para poblar `Media.OriginId` y `Variant.MediaId` en la BD.

---

## Resumen: qué Mirror usa cada workflow

| Workflow | Mirror al inicio | Razón |
|---|---|---|
| **Productos** | `SyncProductsV2` | Reconciliar el catálogo antes de decidir qué crear/actualizar/borrar |
| **Stock** | Ninguno | El stock se sobreescribe siempre |
| **Clientes** | `SyncCompanies` + `SyncPriceLists` | Reconciliar companies y tarifas antes de la decisión |
| **Pedidos** | Ninguno | Los pedidos van de Shopify → ERP, no al revés |
| **Imágenes PIM** | Ninguno | Solo genera un CSV para el PIM, no escribe en Shopify |
| **Imágenes Shopify** | `SyncProductMedias` | Reconciliar imágenes existentes antes de decidir qué crear/borrar/asociar |

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [`10-loaders.md`](10-loaders.md) | Visión general: qué hace cada loader y qué escribe en Shopify |
| [`10c-loaders-metodos.md`](10c-loaders-metodos.md) | Código completo con anotaciones de los métodos más complejos |
| [`04d-decisions.md`](04d-decisions.md) | Los Decisions que producen los inputs que reciben los loaders |
| [`05-transformers.md`](05-transformers.md) | Los Transformers que convierten los modelos antes de llegar al loader |
