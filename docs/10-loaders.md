---
tags:
  - Loaders
  - Mirror
  - Shopify
---

# 10 — Loaders y Mirror: escritura y reconciliación

Este documento cubre las dos capas finales del sistema: los **Loaders** (que escriben en Shopify) y las actividades **Mirror** (que reconcilian la base de datos de transacciones con el estado real de Shopify).

> **¿Quieres ver los campos de los modelos de input o el detalle de cada sub-operación?**
> → [`10b-loaders-detalle.md`](10b-loaders-detalle.md) — input models, sub-operaciones con referencias cruzadas y resumen de Mirrors.
>
> **¿Quieres ver el código fuente de los métodos más complejos?**
> → [`10c-loaders-metodos.md`](10c-loaders-metodos.md) — `CreateProductsAndVariants`, `RebuildProductOptions`, `RemoveProductsIfLastVariants`, `CreateCompanies`, `CreateMetafields`, `SyncCompanies`.

---

## ¿Qué es un Loader?

Un **Loader** es la actividad que cierra la cadena ETL. Es la que realmente llama a la API de Shopify para escribir datos. Después de que los Extractors han leído del origen y los Transformers han convertido los modelos, el Loader hace las mutaciones GraphQL.

Todos los Loaders siguen el mismo patrón interno:

1. Recibe un input del tipo `*LoaderInput` con todas las operaciones a realizar.
2. Comprueba `RunActivity` — si es `false`, salta sin hacer nada.
3. Para cada operación (crear, actualizar, borrar...), llama al `ShopifySDK`.
4. Después de cada llamada exitosa, llama al `TransactionsService` para **registrar el resultado en la base de datos** — guardando el par `OriginId ↔ DestinoId`.
5. Devuelve un `ActivityResult` con los logs de lo que ocurrió.

El paso 4 es el que mantiene la BD de transacciones viva. **Los Loaders no solo escriben en Shopify: también actualizan la BD local en el mismo momento**.

Además, todos los Loaders llaman a `BrakeGuard()` entre sub-operaciones. Si el sistema tiene el freno activado (`WorkflowsBrakeService`), el Loader lanza una excepción y el workflow queda suspendido.

---

## ¿Qué son las actividades Mirror?

Las actividades **Mirror** leen el estado real de Shopify y lo vuelcan en la base de datos de transacciones para asegurarse de que ambas están alineadas antes de tomar decisiones.

¿Por qué hacen falta si los Loaders ya actualizan la BD?

- Un Loader puede haber tenido un error parcial y dejado datos incompletos.
- Alguien pudo haber hecho un cambio manual directamente en Shopify.
- Hubo un problema de red que impidió registrar el resultado.

Por eso algunas workflows arrancan con un Mirror. La secuencia real es:

```text
Mirror (reconciliar BD con el estado actual de Shopify)
     ↓
Extract (leer datos del origen: PIM o ERP)
     ↓
Decision (comparar origen con BD reconciliada → decidir qué crear/actualizar/borrar)
     ↓
Transform (convertir modelos de dominio a inputs de la API)
     ↓
Load (escribir en Shopify + registrar resultado en BD)
```

---

## 1. Loader: `ProductsWithVariantsCreate`

Archivo: `Loaders/Shopify/Products/ProductsWithVariantsCreate.cs`

Crea productos y variantes en Shopify. Recibe `ProductsWithVariantsCreateLoaderInput`.

### Sub-operaciones (en orden)

#### `ProcessProducts` → `CreateProductsAndVariants()`

Esta es la sub-operación más compleja. Ejecuta cinco pasos encadenados:

**Paso 1 — Crear productos en bulk**

Llama a `_shopifySdk.Products.BulkCreate()`. Antes de hacerlo, inserta artificialmente un valor `"$"` como primer valor en cada opción. ¿Por qué? Shopify crea automáticamente una "variante por defecto" con los primeros valores de cada opción; al insertar `$` primero, esa variante por defecto queda marcada con `$` y puede identificarse para borrarla al final.

**Paso 2 — Excluir de mercados (opcional)**

Si `ExcludeNewProductsFromMarkets = true`, recién creado el producto se excluye de **todos los mercados de Shopify**. El razonamiento: Shopify incluye automáticamente el producto en todos los mercados sin asignarle precio, lo que podría exponerlo como "sin precio". Es más seguro excluirlo ahora y dejar que el workflow de precios lo incluya en los mercados correctos cuando ya tenga precio.

**Paso 3 — Crear variantes**

Consulta la BD para saber qué productos se crearon bien (los fallidos no tendrán `DestinoId`), y con esa información crea las variantes de los productos exitosos. Requiere SKU obligatorio — si alguna variante no tiene, lanza `ShopifyDeveloperErrorException` y aborta.

**Paso 4 — Eliminar la variante por defecto**

Borra las variantes con SKU `"$"` que Shopify creó automáticamente. Este paso también sirve como **señal de estado**: si en el próximo ciclo un producto todavía tiene la variante `$`, significa que su carga no se completó correctamente.

**Paso 5 — Reordenar las opciones**

Shopify puede reordenar las opciones de un producto. Se reenvían las opciones con el orden que tenía el PIM para garantizar que las variantes aparezcan en el orden correcto.

#### `ProcessProductOptionsToCreate`

Añade nuevas opciones a productos que ya existen (caso: el PIM añade una nueva dimensión de variante como "Talla" a un producto que antes no la tenía).

#### `ProcessVariants`

Añade variantes a productos existentes sin modificar el producto en sí. SKU obligatorio.

#### `PublishProducts`

Publica **todos** los productos de la BD en el canal de publicación configurado (`ShopifyCredentials:PublicationId`). Se usa solo cuando se pide explícitamente; aplica al catálogo completo.

---

## 2. Loader: `ProductsWithVariantsUpdate`

Archivo: `Loaders/Shopify/Products/ProductsWithVariantsUpdate.cs`

Actualiza productos y variantes existentes en Shopify.

### Sub-operaciones

#### `ProcessProducts`

Llama a `Products.BulkUpdate()`. Detalle importante: si un metafield tiene valor `null` o vacío, en lugar de enviarlo con valor nulo (que la API de Shopify no acepta bien), lo **elimina explícitamente** con `Metafields.Delete()`.

#### `ProcessRebuildProductOptions`

La operación más delicada del sistema. Se ejecuta cuando las opciones de un producto han cambiado estructuralmente (ej.: el PIM añade o elimina una dimensión de variante). Shopify no permite reemplazar opciones directamente, así que hay que usar una **variante centinela**:

1. **Poner el producto en borrador** — los cambios serán invisibles al cliente durante la migración.
2. **Añadir el valor `$`** a todas las opciones actuales del producto.
3. **Crear la variante centinela** — una variante ficticia con `$` en todas las opciones. Esto garantiza que el producto nunca se quede sin variantes (Shopify lo exige). Si la centinela ya existe de una ejecución anterior fallida, se recupera en lugar de crear una nueva.
4. **Borrar todas las variantes reales** actuales.
5. **Migrar las opciones** en un bucle: alterna creación y borrado de opciones respetando el límite de 3 opciones por producto de Shopify. Si todas las opciones van a cambiar y hay que borrar mientras se crea, lo hace iteración a iteración.
6. **Crear las nuevas variantes** con las opciones correctas.
7. **Borrar la variante centinela**.
8. **Restaurar el estado** del producto (activo/borrador según era antes).
9. **Reordenar las opciones** al finalizar.

Pre-checks antes de empezar: descarta productos que superen 3 opciones o que tengan variantes duplicadas (misma combinación de valores de opción), con `LogError` para cada uno.

#### `ProcessProductOptionsAndValuesToReorder`

Cambia el orden de los valores de las opciones para que coincidan con el PIM. No modifica los valores en sí, solo su posición.

#### `ProcessVariants`

Actualiza variantes individuales. Igual que en productos: elimina metafields nulos explícitamente.

#### `ProcessInventoryItems`

Actualiza propiedades del `InventoryItem` (como `Sku` o configuración de seguimiento de inventario) a partir del ID de variante o del ID de InventoryItem.

---

## 3. Loader: `ProductsWithVariantsDelete`

Archivo: `Loaders/Shopify/Products/ProductsWithVariantsDelete.cs`

Elimina productos o variantes en Shopify.

### Lógica especial: `RemoveProductsIfLastVariants`

Antes de borrar variantes, el loader comprueba si alguna de las variantes a borrar es **la última variante de su producto**. En ese caso, Shopify no permitiría borrar la variante sola, así que en lugar de eso se **promociona el producto a borrado**. Esto evita errores de la API y es más limpio.

### Sub-operaciones

| Sub-operación | Qué hace |
|---|---|
| `ProcessVariantsToDelete` | Borra variantes individuales con `Variants.BulkDelete()` |
| `ProcessProductsToDelete` | Borra el producto completo con `Products.Delete()` |

En ambos casos el resultado se registra en la BD con `TransactionsService`.

---

## 4. Loader: `PriceListsB2B`

Archivo: `Loaders/Shopify/Products/PriceListsB2B.cs`

Gestiona las listas de precios B2B en Shopify. Es el loader con mayor variedad de operaciones.

### Modelo de datos: Catálogo + PriceList + Publicación

En Shopify B2B una lista de precios tiene tres objetos relacionados:

```text
Catalog (catálogo B2B, agrupa productos visibles para esa tarifa)
  └── PriceList (la tarifa con moneda y precios fijos)
  └── Publication (permite publicar/despublicar productos de esa tarifa)
```

Cuando se crea una nueva tarifa en Pataky, se crean los tres objetos. Cuando se borra, se borra solo el catálogo (Shopify elimina los otros en cascada).

### Sub-operaciones

#### `ProcessPriceListsToDelete`

Elimina el catálogo (lo que elimina la PriceList y la publicación en cascada). Usa la BD para encontrar el `CatalogId` a partir del `PriceListId`.

#### `ProcessPriceListsToCreate`

Para cada tarifa nueva:
1. Crear el **catálogo** con `Catalogs.Create()`.
2. Crear la **publicación** del catálogo con `Catalogs.PublicationCreate()`.
3. Crear la **PriceList** asociada al catálogo con `PriceLists.Create()`.
4. Registrar todo en la BD con `TransactionsService`.

Estas tres operaciones se ejecutan en paralelo para las distintas tarifas.

#### `ProcessSetProductVariantsFixedPrices`

Asigna precios fijos a variantes dentro de una tarifa. Los `OriginId` de PriceLists se convierten a IDs de Shopify antes de llamar al SDK (`ReplaceOriginIdsWithShopifyIdsAsync`).

#### `ProcessResetProductVariantsFixedPrices`

Quita el precio fijo de una variante en una tarifa (vuelve al precio base calculado por ajuste porcentual).

#### `ProcessExcludeProducts`

Despublica un producto de la publicación de un catálogo para que no sea visible desde esa tarifa, sin borrarlo de Shopify.

#### `ProcessQuantityPricesRules`

Crea o elimina:
- **QuantityRules**: mínimo, múltiplo y máximo de unidades que se pueden comprar de una variante en una tarifa.
- **QuantityPriceBreaks**: precio especial a partir de N unidades.

Incluye validación automática: antes de crear un `QuantityPriceBreak`, comprueba que respeta la `QuantityRule` de su variante (mínimos, máximos, múltiplos). Si no la respeta, se descarta con `LogWarning`.

Nota técnica: Shopify procesa **primero los borrados y después los creates** por separado. Si se mezclan en una sola llamada, Shopify no garantiza el orden. Por eso el loader hace dos llamadas separadas.

---

## 5. Loader: `ProductsMedias`

Archivo: `Loaders/Shopify/Products/ProductsMedias.cs`

Gestiona imágenes y otros medios de productos en Shopify.

### Sub-operaciones

| Sub-operación | Descripción |
|---|---|
| `ProcessDeleteMedias` | Borra medios de Shopify por ID de Shopify. Registra el borrado en la BD. |
| `ProcessCreateMedias` | Sube nuevas imágenes (por URL o por fichero binario). Añade el `OriginId` en el campo `ALT` para poder hacer seguimiento desde Mirror. Si tienen `Position`, las reordena automáticamente después de subir. |
| `ProcessUpdateMedias` | Actualiza el `ALT` o la `Url` de imágenes existentes. Recupera el `OriginId` de la BD para no perderlo al sobrescribir el `ALT`. Omite videos externos. |
| `ProcessAppendFiles` | Asocia ficheros de la biblioteca de archivos de Shopify a un producto usando `ProductSetInput`. |
| `ProcessDetachMedias` | Desasocia imágenes de variantes específicas sin eliminarlas del producto. En lotes de 100. |
| `ProcessAppendMedias` | Asocia imágenes ya subidas al producto a variantes concretas. Solo 1 imagen por variante. En lotes de 100. |
| `PublishProductsWithMedias` | Publica todos los productos de la BD que tengan al menos una imagen asociada. |

---

## 6. Loader: `SyncStock`

Archivo: `Loaders/Shopify/Stock/SyncStock.cs`

Actualiza el inventario de variantes en Shopify. Dentro de `ProcessStock` ejecuta dos sub-fases:

### Fase 1: `UpdateVariants`

Actualiza `InventoryPolicy` (si se puede vender sin stock) y metafields de las variantes que lo necesiten. Elimina metafields nulos explícitamente. Solo procesa las variantes donde al menos uno de estos campos tiene valor.

### Fase 2: `InventorySetQuantities`

Establece el stock exacto de cada variante en cada almacén usando `inventorySetQuantities` de la API de Shopify. Puntos clave:
- Trabaja en **lotes de 250** unidades (límite de la API).
- Usa `IgnoreCompareQuantity = true` para que el valor se establezca directamente sin comparar con la cantidad anterior.
- El `InventoryItemId` (distinto del `VariantId`) se busca en la BD de transacciones usando `FindInventoryItemsIds`.
- Si no encuentra el `InventoryItemId`, descarta la variante con `LogWarning`.

---

## 7. Loader: `CompaniesWithContactsLoader`

Archivo: `Loaders/Shopify/Companies/CompaniesWithContactsLoader.cs`

El loader más complejo del sistema. Gestiona la estructura jerárquica `Company → Location → Contact → Role` en Shopify B2B.

### Las 17 sub-operaciones (en orden de ejecución)

El orden es fundamental: siempre se borra antes de crear, y las companies antes que las locations, y las locations antes que los contacts.

| # | Sub-operación | Qué hace |
|---|---|---|
| 1 | `ProcessRevokeRoles` | Desasigna roles de contactos (en paralelo) |
| 2 | `ProcessDeleteContacts` | Borra contactos. Los marcados como `IsAgent = true` se omiten aunque estén en la lista. |
| 3 | `ProcessDeleteLocations` | Borra sucursales con `Locations.Delete()` |
| 4 | `ProcessDeleteCompanies` | Borra empresas. Antes desasocia todos sus contactos con `CompanyContactRemoveFromCompany`. |
| 5 | `ProcessCreateCompanies` | Crea empresas con su primera location incluida (en la misma llamada `CompanyCreate`). Las locations adicionales se crean después. Los contactos se crean a continuación. Si el customer (por email) ya existía en Shopify, usa `CompanyAssignCustomerAsContact` en lugar de crear uno nuevo. Asigna el primer contacto como MainContact. |
| 6 | `ProcessUpdateCompanies` | Actualiza metadatos (nombre, ExternalId) de empresas |
| 7 | `ProcessCreateLocations` | Añade nuevas sucursales a empresas existentes (en paralelo) |
| 8 | `ProcessUpdateLocations` | Actualiza metadatos de sucursales (nombre, ExternalId) |
| 9 | `ProcessUpdateCompanyLocationsTaxSettings` | Actualiza exenciones fiscales y registro fiscal de sucursales |
| 10 | `ProcessUpdateLocationAddresses` | Actualiza las direcciones de envío y/o facturación. Si tienen la misma dirección para billing y shipping, usa una sola llamada. |
| 11 | `ProcessCreateContacts` | Crea contactos. Si el customer ya existe (por email) y ya está asociado a la company, no hace nada. |
| 12 | `ProcessUpdateContacts` | Actualiza email y nombre de contactos |
| 13 | `ProcessAddCustomersTags` | Añade etiquetas a customers. Solo añade las que faltan; no borra las existentes. |
| 14 | `ProcessMainContactsToAssign` | Asigna el contacto principal de cada empresa con `AssignMainContact()` |
| 15 | `ProcessCreateMetafields` | Crea/actualiza metafields de companies, locations y customers. En lotes de 25 (límite de `metafieldsSet`). |
| 16 | `ProcessMarketsAndPriceListsToUpdate` | Actualiza qué sucursales pertenecen a cada tarifa y/o mercado. En lotes de 250. Si `MarketsAndPriceListsRemoveMissingLocations = true`, también elimina las sucursales que ya no deberían estar. |
| 17 | `ProcessAssignRoles` | Asigna roles de acceso a contactos en sucursales con `Companies.Roles.AssignRole()` |

---

## 8. Loader: `OrdersLoader`

Archivo: `Loaders/Shopify/Orders/OrdersLoader.cs`

Este loader no escribe datos de origen en Shopify. Gestiona el **estado** de los pedidos existentes en Shopify después de que el ERP los procesó.

### Sub-operaciones

| Sub-operación | Qué hace |
|---|---|
| `ProcessAddTags` | Añade etiquetas a pedidos (por ejemplo, `"Sincronizado"`) |
| `ProcessCreateManualPayments` | Registra un pago manual en un pedido (para reflejar pagos procesados fuera de Shopify) |
| `ProcessordersToCancel` | Cancela pedidos con motivo, restock y notificación al cliente configurables |
| `ProcessOrdersToMarkAsPaid` | Marca pedidos como pagados con `MarkOrderAsPaid()` |
| `ProcessFulfillmentsCreate` | Crea fulfillments (envíos). Requiere recuperar el `FulfillmentOrderId` del pedido antes de crear el fulfillment. |
| `ProcessFulfillmentEventsCreate` | Crea eventos de fulfillment: cambios de estado como "en tránsito", "entregado", etc. Requiere el `FulfillmentId` del pedido. |

---

## Las actividades Mirror

### ¿Dos versiones de SyncProducts?

- **`SyncProducts`** (v1, legado): usa `BulkGetAllWithVariantsExtended()` — devuelve un stream mezclado de productos, variantes y metafields como objetos dinámicos `JObject`. Procesamiento secuencial con consultas a BD por cada elemento.
- **`SyncProductsV2`** (v2, actual): usa `BulkGetAllWithMetafieldKeyFilter()` — filtra por clave de metafield antes de devolver los datos, reduciendo el tamaño del stream. Carga toda la BD en memoria al inicio (índices por DestinoId y OrigenId) y procesa en una sola pasada. Mucho más eficiente para catálogos grandes.

En ambos casos, el `OriginId` de cada producto/variante se lee del metafield cuya clave está configurada en `Mirror:Metafield_Name_OriginId` (por defecto `"originId"`).

---

### 9. Mirror: `SyncProducts` (v1)

Archivo: `Loaders/Shopify/Mirror/SyncProducts.cs`

Flujo:
1. `BulkGetAllWithVariantsExtended()` devuelve un stream de objetos; el código los clasifica en productos, variantes o metafields según si el primer campo del `JObject` contiene `"Product"`, `"Variant"` o `"Metafield"`.
2. Para cada **producto**: busca su metafield `originId` y crea/actualiza el registro en la BD (con sus opciones). Si hay duplicados de `originId` en Shopify (dos productos con el mismo origen), les asigna GUIDs aleatorios para romper la ambigüedad.
3. Para cada **variante**: igual, usando el metafield `originId`. Si no tiene metafield, crea una "variante por defecto" con `OriginId = "{productoDestinoId}-$"`.
4. Al final, borra de la BD los productos y variantes que ya no existen en Shopify.

---

### 10. Mirror: `SyncProductsV2` (v2)

Archivo: `Loaders/Shopify/Mirror/SyncProductsV2.cs`

Mejoras sobre v1:
- Carga toda la BD en 6 diccionarios en memoria: `productsByDestinoId`, `productsByOrigenId`, `variantsByDestinoId`, `variantsByOrigenId`, `optionsByDestinoId`, `optionsByOrigenId`. Cero consultas a BD durante el procesamiento.
- Lógica **"Claim"** para manejar conflictos de DestinoId/OrigenId entre registros existentes en BD:
  - Si el `DestinoId` de Shopify cambió (producto recreado), actualiza el `DestinoId` en BD.
  - Si el `OriginId` del metafield cambió, actualiza el `OrigenId` en BD. Si ya está en uso por otro producto que todavía existe en Shopify, asigna un GUID al conflictivo.
  - Duplicados de `OriginId` en Shopify → todos reciben GUIDs para invalidarlos.
- Sincronización de **opciones** en el mismo paso (`SyncProductOptions`): añade, actualiza y borra opciones según el estado real de Shopify.
- `SaveChangesAsync()` solo al final de productos y al final de variantes (no por cada elemento).

---

### 11. Mirror: `SyncProductMedias`

Archivo: `Loaders/Shopify/Mirror/SyncProductMedias.cs`

Sincroniza las imágenes de productos en la BD.

1. `BulkGetAllWithVariantsImages()` devuelve productos, variantes y medios en un stream.
2. Los medios de variantes aparecen duplicados en el stream: una entrada como imagen (con el ID de imagen) y otra entrada que indica a qué variante corresponde (con el ID de la variante en `MimeType`). El código fusiona estos pares para poblar `variant.Image`.
3. Para cada imagen: si no existe en la BD, la crea. El `OriginId` se extrae del campo `ALT` de la imagen (donde `ProductsMedias.CreateMedias()` guardó el `OriginId` al subirla).
4. Si la imagen tiene variante asociada, actualiza `Variant.MediaId` en la BD.
5. Elimina de la BD las imágenes que ya no existen en Shopify.

---

### 12. Mirror: `SyncPriceLists`

Archivo: `Loaders/Shopify/Mirror/SyncPriceLists.cs`

Sincroniza las listas de precios y sus asociaciones de variantes en la BD.

1. `PriceLists.BulkGetAll()` devuelve todas las PriceLists de Shopify.
2. Para cada PriceList que no existe en la BD: la crea. Si no tiene catálogo, lo crea. Si no tiene publicación, la crea también.
3. Para cada PriceList ya en BD: llama a `GetPrices()` para obtener las variantes con precio fijo en esa tarifa, y sincroniza la tabla `PriceListsVariants`:
   - **Añade** las variantes que están en Shopify pero no en BD.
   - **Elimina** las variantes que están en BD pero ya no en Shopify.
   - **No almacena el precio real**: guarda el importe como `0`. La lógica de precios la gestiona el workflow de Productos, no el Mirror.
4. Guarda los cambios por PriceList (no en batch al final) para tener la información disponible lo antes posible.

---

### 13. Mirror: `SyncCompanies`

Archivo: `Loaders/Shopify/Mirror/SyncCompanies.cs`

El Mirror más completo. Sincroniza Companies, CompanyContacts, Locations, Roles, agentes y customers sin empresa.

**Fase 1 — `ProcessCompanies`**: upsert de empresas por `ExternalId`.
- Si ya existe en BD: actualiza `DestinoId` y `DefaultRole`.
- Si no existe en BD: la crea con su MainContact Customer.
- Si existe en BD pero no en Shopify: la borra junto con sus CompanyContacts.

**Fase 2 — `ProcessCompanyContacts`**: upsert de contactos por email (en minúsculas).
- Si ya existe en BD: actualiza `CompanyAsMainContactId`/`CompanyAsContactId`.
- Si no existe en BD: crea el Customer (o lo actualiza si el DestinoId cambió) y crea el CompanyContact.
- Si existe en BD pero no en Shopify: lo borra.

**Fase 3 — `ProcessLocations`**: upsert de locations por `ExternalId`.
- Si ya existe en BD: actualiza `DestinoId` y `CompanyId`.
- Si no existe en BD: la crea.
- Si existe en BD pero no en Shopify: la borra.

**Fase 4 — `ProcessRoles`**: upsert de roles (combinación location-contacto).
- `OrigenId` del rol = `"{locationExternalId}-{contactEmail}"`.
- Si ya existe en BD: actualiza `OrigenId` y `Referencia`.
- Si no: lo crea.

**Fase 5 — `ConvertEmails`**: normaliza todos los `OriginIds` de Customers a minúsculas (corrección de inconsistencias históricas).

**Fase 6 — `ProcessAgents`**: si `ShopifyCredentials:AgentTags` está configurado, busca en Shopify los customers con esas etiquetas y los registra en la BD con `IsAgent = true`.

**Fase 7 — `ProcessCustomersWithoutCompany`**: registra en la BD los customers de Shopify que no tienen empresa asociada (para poder enviarles emails, asignarles roles especiales, etc.).

---

### 14. Mirror: `MirrorMediasLoad`

Archivo: `Loaders/Shopify/Mirror/MirrorMediasLoad.cs`

Mirror especializado para el workflow de Imágenes Shopify. Recibe como input una lista de `ProductImagesMirror` (la asignación imagen→variante según el PIM) y la usa para registrar el mapping imagen↔variante en la BD.

A diferencia de `SyncProductMedias` (que solo mira Shopify), `MirrorMediasLoad` usa **la información del PIM** para hacer el matching:

1. Obtiene todos los productos con imágenes y variantes de Shopify.
2. Para cada imagen de Shopify de cada producto:
   - Si tiene variante asociada: busca en el input qué `OriginId` del PIM corresponde a esa variante y crea el registro `Media` con ese `OriginId`.
   - Si es imagen de galería (sin variante): usa la primera imagen del PIM sin procesar.
3. Asigna la imagen a la variante en la BD (`Variant.MediaId`).

---

## Resumen: qué Mirror usa cada workflow

| Workflow | Mirror al inicio | ¿Por qué? |
|---|---|---|
| **Productos** | `SyncProductsV2` | Reconcilia el catálogo antes de decidir qué crear/actualizar/borrar |
| **Stock** | Ninguno | El stock siempre se sobreescribe — no hay decisión que tomar |
| **Clientes** | `SyncCompanies` + `SyncPriceLists` | Reconcilia companies y tarifas antes de la decisión |
| **Pedidos** | Ninguno | Los pedidos van en dirección inversa (Shopify → ERP) |
| **Imágenes PIM** | Ninguno | Solo genera un CSV para el PIM, no escribe en Shopify |
| **Imágenes Shopify** | `SyncProductMedias` | Reconcilia las imágenes existentes antes de decidir qué crear/borrar/asociar |

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [`10b-loaders-detalle.md`](10b-loaders-detalle.md) | Campos de los modelos de input, sub-operaciones con referencias a métodos, detalle de Mirrors |
| [`10c-loaders-metodos.md`](10c-loaders-metodos.md) | Código fuente completo con anotaciones paso a paso |
| [`05-transformers.md`](05-transformers.md) | Los Transformers que producen los inputs que reciben los Loaders |
| [`04d-decisions.md`](04d-decisions.md) | Los Decisions cuya clasificación dirige qué operaciones hace cada Loader |
