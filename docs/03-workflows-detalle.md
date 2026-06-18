# 03 — Los workflows del sistema

Este documento describe en detalle los 6 workflows del proyecto: qué hace cada uno, qué sistemas conecta, qué actividades lo componen y qué lógica especial tiene.

---

## Visión general

| # | Workflow | Dirección | Actividades |
|---|---|---|---|
| 1 | **Productos** | PIM → Shopify | Mirror, Extrae, Decide, Transforma ×3, Carga ×3 |
| 2 | **Stock** | ERP → Shopify | Extrae, Transforma, Carga |
| 3 | **Clientes** | ERP → Shopify B2B | Mirror ×2, Extrae, Decide, Transforma, Carga |
| 4 | **Pedidos** | Shopify → ERP | Extrae, Transforma, Carga en ERP, Etiqueta en Shopify |
| 5 | **Imágenes PIM** | FTP → PIM | Extrae imágenes del FTP, genera CSV |
| 6 | **Imágenes Shopify** | PIM → Shopify | Mirror, Extrae, Decide, Transforma, Carga |

---

## El ciclo completo: Mirror → Extract → Decidir → Transformar → Cargar

Antes de entrar en cada workflow, es importante entender que la cadena no es solo ETL (Extract-Transform-Load). En los workflows más complejos hay dos capas adicionales:

### La capa de Decisión

Entre el Extract y el Transform existe siempre una actividad de **Decisión** que compara los datos del origen con la **base de datos de transacciones** (TransactionsDB) y clasifica cada elemento: ¿hay que crearlo? ¿actualizarlo? ¿borrarlo?

La TransactionsDB es la pieza central: guarda la relación `OriginId ↔ DestinoId` para cada producto, variante, imagen, empresa, etc. Cada vez que el Loader escribe algo en Shopify, inmediatamente registra el par en la TransactionsDB. Así la siguiente ejecución sabe qué ya existe y qué no.

### La capa Mirror

Pero los Loaders pueden fallar a medias, puede haber cambios manuales en Shopify, o puede haber inconsistencias por errores de red. Para garantizar que la TransactionsDB esté en sincronía con el estado real de Shopify antes de tomar decisiones, algunos workflows arrancan con una actividad **Mirror**.

Una actividad Mirror **lee Shopify en bulk y actualiza la TransactionsDB** — no modifica Shopify, solo actualiza el estado local. Es una operación de reconciliación.

El patrón completo de los workflows con Mirror es:

```
╔══════════════════════════════════════════════════════════════╗
║  MIRROR — Lee el estado real de Shopify                      ║
║           Actualiza la TransactionsDB                        ║
╚══════════════════════════════════════════════════════════════╝
                              ↓
╔══════════════════════════════════════════════════════════════╗
║  EXTRACT — Lee los datos del origen (PIM / ERP)             ║
╚══════════════════════════════════════════════════════════════╝
                              ↓
╔══════════════════════════════════════════════════════════════╗
║  DECISION — Compara origen con TransactionsDB               ║
║             Clasifica: crear / actualizar / borrar          ║
╚══════════════════════════════════════════════════════════════╝
                              ↓
╔══════════════════════════════════════════════════════════════╗
║  TRANSFORM — Convierte modelos del origen al formato        ║
║              de la API de Shopify                           ║
╚══════════════════════════════════════════════════════════════╝
                              ↓
╔══════════════════════════════════════════════════════════════╗
║  LOAD — Escribe en Shopify                                  ║
║         Registra OriginId↔DestinoId en TransactionsDB       ║
╚══════════════════════════════════════════════════════════════╝
```

Los workflows sin Mirror (Stock, Pedidos, Imágenes PIM) son casos especiales donde no hay decisión que tomar o donde el flujo va en dirección contraria.

---

## 1. Workflow de Productos

**Fichero**: `ElsaServer/Workflows/ProductsWorkflow.cs`
**Dirección**: SalesLayer (PIM) → Shopify
**Propósito**: Mantener el catálogo de productos de Shopify sincronizado con el PIM.

### Grafo del workflow

```
╔═══════════════════════════════════════════════════════════════╗
║  MIRROR                                                       ║
║  SyncProductsV2                                               ║
║  └── Lee todos los productos+variantes de Shopify vía Bulk   ║
║  └── Usa el metafield "originId" para identificar cada uno   ║
║  └── Actualiza la TransactionsDB con los DestinoIds actuales  ║
╚═══════════════════════════════════════════════════════════════╝
                              ↓
╔═══════════════════════════════════════════════════════════════╗
║  EXTRACT                                                      ║
║  ProductsWithImagesExtract                                    ║
║  └── Lee todos los productos e imágenes del PIM (SalesLayer) ║
║  └── Agrupa variantes por CodigoAgrupacion                   ║
║  └── Produce dos salidas: productos e imágenes               ║
╚═══════════════════════════════════════════════════════════════╝
                              ↓
╔═══════════════════════════════════════════════════════════════╗
║  DECISION                                                     ║
║  ProductsRebuildDecision                                      ║
║  └── Compara PIM con TransactionsDB                          ║
║  └── 7 salidas: ProductosCrear / ProductosActualizar /       ║
║      ProductosBorrar / VariantesCrear / VariantesActualizar  ║
║      / VariantesBorrar / RebuildProductOptions               ║
╚═══════════════════════════════════════════════════════════════╝
                              ↓
         ┌────────────────────┼────────────────────┐
         ↓                    ↓                    ↓
╔══════════════════╗  ╔══════════════════╗  ╔══════════════════╗
║ TRANSFORM+LOAD   ║  ║ TRANSFORM+LOAD   ║  ║ TRANSFORM+LOAD   ║
║ Crear            ║  ║ Actualizar       ║  ║ Borrar/Archivar  ║
║                  ║  ║                  ║  ║                  ║
║ ProductsCreate   ║  ║ ProductsUpdate   ║  ║ ProductsDelete   ║
║ Transform        ║  ║ Transform        ║  ║ Transform        ║
║    ↓             ║  ║    ↓             ║  ║    ↓             ║
║ ProductsWith     ║  ║ ProductsWith     ║  ║ ProductsWith     ║
║ VariantsCreate   ║  ║ VariantsUpdate   ║  ║ VariantsDelete   ║
╚══════════════════╝  ╚══════════════════╝  ╚══════════════════╝
```

### Actividades en detalle

#### `SyncProductsV2` — Mirror de productos

Esta actividad garantiza que la TransactionsDB sea fiel al estado real de Shopify antes de tomar ninguna decisión. Sin ella, podría haber inconsistencias acumuladas (errores previos, cambios manuales en Shopify...) que harían tomar decisiones equivocadas.

Flujo interno:
1. Llama a `BulkGetAllWithMetafieldKeyFilter(nameMetafieldOrigenId)` — devuelve en streaming todos los productos, variantes y el metafield `originId` de cada uno.
2. Carga toda la TransactionsDB en memoria (6 índices por DestinoId y OriginId) para hacer O(1) lookups sin consultas a BD por cada elemento.
3. Para cada producto de Shopify: actualiza el registro en BD (crea si no existe, actualiza `DestinoId`/`OrigenId` si cambiaron).
4. Para cada variante: igual.
5. Sincroniza las opciones de producto.
6. Al final: elimina de la BD los registros cuyos `DestinoId` ya no existen en Shopify.

Lógica de deduplicación ("Claim"): si dos productos en Shopify tienen el mismo `OriginId`, el que ya estaba en BD lo conserva; el otro recibe un GUID aleatorio para que vuelva a procesarse correctamente.

#### `ProductsWithImagesExtract` — Extracción del PIM

- Se conecta al canal de salida de **SalesLayer** y descarga todos los productos.
- Agrupa los productos en dos tipos:
  - **Productos simples**: los que no tienen `CodigoAgrupacion`.
  - **Productos con variantes**: los que comparten el mismo `CodigoAgrupacion` (se agrupan en un único `Product` con múltiples variantes).
- Los productos que están marcados como *Visible Y Obsoleto* se tratan como *Invisible*.
- Elimina productos y variantes con IDs duplicados (y los loguea como error).
- Produce dos salidas independientes: la lista de productos (para el workflow de productos) y la lista de imágenes (para el workflow de imágenes).

#### `ProductsRebuildDecision` — La decisión

Esta actividad compara los productos del PIM con lo que hay guardado en la TransactionsDB y clasifica cada producto en hasta 7 canales de salida:

| Canal | Cuándo |
|---|---|
| `ProductosCrear` | Existe en PIM, no en BD |
| `ProductosActualizar` | Existe en PIM y en BD, las opciones **no** han cambiado |
| `RebuildProductOptions` | Existe en PIM y en BD, pero las opciones **sí** han cambiado |
| `ProductosBorrar` | Marcado como `Deleted` en PIM, o no existe en PIM pero sí en BD |
| `VariantesCrear` | Variante en PIM, no en BD |
| `VariantesActualizar` | Variante en PIM y en BD |
| `VariantesBorrar` | Variante en BD pero no en PIM |

Lógica especial:
- Si **todas** las variantes de un producto van a borrarse → se archiva el producto entero en lugar de borrar variantes (Shopify no permite borrar la última variante).
- Si un producto se va a archivar → se eliminan las operaciones de borrado de sus variantes (es redundante y puede dar error).
- Productos con más de **2048 variantes** se descartan con error (límite de Shopify).

#### `ProductsCreateTransform`, `ProductsUpdateTransform`, `ProductsDeleteTransform` — Transformación

Convierten los modelos del PIM (`IProduct`, `IVariant`) al formato que espera la API de Shopify. Hay un transformador independiente para cada operación porque cada una necesita datos distintos. Ver detalle en el apartado 05.

#### `ProductsWithVariantsCreate` — Loader de creación

Crea productos y variantes en Shopify en hasta 5 pasos encadenados:

1. **BulkCreate de productos** — inserta artificialmente el valor `$` como primer valor en cada opción. Así la variante por defecto que Shopify genera automáticamente queda marcada con `$` y se puede identificar para borrarla.
2. **Excluir de mercados** — recién creado el producto, se excluye de todos los mercados para que no aparezca sin precio. El workflow de precios lo incluirá después en los mercados correctos.
3. **Registrar en TransactionsDB** con `transactionsService.Products.Create()`.
4. **Crear variantes** en los productos que se crearon bien.
5. **Eliminar variante `$`** (la creada automáticamente por Shopify).
6. **Reordenar opciones** para que coincidan con el orden del PIM.

Si en el siguiente ciclo un producto todavía tiene la variante `$`, es señal de que su carga no se completó y necesita reintentarse.

#### `ProductsWithVariantsUpdate` — Loader de actualización

Actualiza productos y variantes. La sub-operación más importante es **RebuildProductOptions**: cuando las opciones de un producto cambian, Shopify no permite reemplazarlas directamente. El proceso usa una **variante centinela** (`$`):

1. Pone el producto en borrador (invisible al cliente durante la migración).
2. Añade el valor `$` a todas las opciones actuales.
3. Crea la variante centinela con `$` en todas las opciones (así el producto nunca se queda sin variantes).
4. Borra todas las variantes reales.
5. Migra las opciones iterativamente, respetando el límite de 3 opciones de Shopify.
6. Crea las nuevas variantes.
7. Borra la variante centinela.
8. Restaura el estado del producto.
9. Reordena las opciones.

#### `ProductsWithVariantsDelete` — Loader de borrado

Antes de borrar variantes, comprueba si alguna es la **última de su producto**. En ese caso, en lugar de borrar la variante (que Shopify rechaza), borra el producto entero. Esta lógica se llama `RemoveProductsIfLastVariants` y ya se aplica también en `ProductsRebuildDecision`, pero el Loader lo repite como salvaguarda.

---

## 2. Workflow de Stock

**Fichero**: `ElsaServer/Workflows/StockWorkflow.cs`
**Dirección**: API de Provalliance → Shopify
**Propósito**: Actualizar el inventario de cada variante en Shopify.

### Grafo del workflow

```
╔══════════════════════════════════════════════════╗
║  EXTRACT                                         ║
║  StockExtract                                    ║
║  └── Llama a /stock/shopify en Provalliance      ║
║  └── Devuelve: VariantId + cantidad disponible   ║
╚══════════════════════════════════════════════════╝
                        ↓
╔══════════════════════════════════════════════════╗
║  TRANSFORM                                       ║
║  StockTransform                                  ║
║  └── Mapea VariantId del ERP → InventoryItemId   ║
║      usando la TransactionsDB                    ║
╚══════════════════════════════════════════════════╝
                        ↓
╔══════════════════════════════════════════════════╗
║  LOAD                                            ║
║  SyncStock                                       ║
║  └── Fase 1: UpdateVariants                      ║
║      (InventoryPolicy + metafields)              ║
║  └── Fase 2: InventorySetQuantities              ║
║      (stock absoluto en lotes de 250)            ║
╚══════════════════════════════════════════════════╝
```

### Por qué no hay paso Mirror ni Decisión

El stock es un **valor absoluto** que se sobreescribe. No hay que comparar ni clasificar: si el ERP dice que hay 42 unidades de la variante X, se actualiza a 42, independientemente de lo que haya antes en Shopify. El `InventoryItemId` (necesario para la llamada a Shopify) se obtiene de la TransactionsDB usando el `VariantId` como clave de búsqueda.

### Las dos fases de `SyncStock`

#### Fase 1: `UpdateVariants`

Actualiza atributos de las variantes que afectan al comportamiento del inventario:
- `InventoryPolicy`: si la variante se puede vender sin stock disponible ("seguir vendiendo" vs. "bloquear").
- Metafields específicos de stock.
- Los metafields con valor `null` se eliminan explícitamente (Shopify no acepta nulos directamente).

#### Fase 2: `InventorySetQuantities`

Establece el stock exacto usando la mutación `inventorySetQuantities` de Shopify:
- Trabaja en **lotes de 250** (límite de la API).
- Usa `IgnoreCompareQuantity = true`: el valor se establece directamente sin comparar con la cantidad anterior.
- Usa `Name: "available"` y `Reason: "other"`.
- Si no se encuentra el `InventoryItemId` en la BD para una variante, se descarta con advertencia en el log.

---

## 3. Workflow de Clientes

**Fichero**: `ElsaServer/Workflows/CompaniesWorkflow.cs`
**Dirección**: API de Provalliance → Shopify B2B
**Propósito**: Sincronizar la estructura de clientes B2B del ERP en Shopify.

### Estructura de datos B2B en Shopify

En el modelo B2B de Shopify, los "clientes" tienen una estructura jerárquica de tres niveles:

```
Company (Empresa)
  └── CompanyLocation (Sucursal)
        └── CompanyContact (Contacto / persona de acceso)
```

Este workflow sincroniza los tres niveles a la vez.

### Grafo del workflow

```
╔════════════════════════════════════════════════════════════════╗
║  MIRROR 1                                                      ║
║  SyncCompanies                                                 ║
║  └── Lee todas las Companies+Locations+Contacts de Shopify     ║
║  └── Reconcilia TransactionsDB con el estado real de Shopify  ║
║  └── También sincroniza Customers sin empresa y agentes       ║
╚════════════════════════════════════════════════════════════════╝
                              ↓
╔════════════════════════════════════════════════════════════════╗
║  MIRROR 2                                                      ║
║  SyncPriceLists                                                ║
║  └── Lee todas las PriceLists de Shopify                       ║
║  └── Reconcilia TransactionsDB (Catalogs, Publications,        ║
║      PriceLists, variantes con precio)                        ║
╚════════════════════════════════════════════════════════════════╝
                              ↓
╔════════════════════════════════════════════════════════════════╗
║  EXTRACT                                                       ║
║  CustomerExtract                                               ║
║  └── Lee todos los clientes del ERP (Provalliance)            ║
║  └── Devuelve ClientResponseModel[] con                       ║
║      CodCom + array de LocationResponseModel                  ║
╚════════════════════════════════════════════════════════════════╝
                              ↓
╔════════════════════════════════════════════════════════════════╗
║  DECISION                                                      ║
║  CustomerDecision                                              ║
║  └── 9 salidas: CreateCompanies / UpdateCompanies /           ║
║      DeleteCompanies / CreateLocations / UpdateLocations /    ║
║      DeleteLocations / CreateContacts / UpdateContacts /      ║
║      DeleteContacts + MainContactAssign + AssignRoles         ║
╚════════════════════════════════════════════════════════════════╝
                              ↓
╔════════════════════════════════════════════════════════════════╗
║  TRANSFORM                                                     ║
║  CustomerTransform                                             ║
║  └── Convierte modelos del ERP a inputs de Shopify API        ║
║  └── Añade metafields (zona_fiscal, external_id)              ║
║  └── Asigna DefaultPriceListId a nuevas sucursales            ║
╚════════════════════════════════════════════════════════════════╝
                              ↓
╔════════════════════════════════════════════════════════════════╗
║  LOAD                                                          ║
║  CompaniesWithContactsLoader                                   ║
║  └── 17 operaciones ordenadas (ver detalle abajo)             ║
╚════════════════════════════════════════════════════════════════╝
```

### El modelo de datos de Provalliance

Cada cliente que devuelve la API de Provalliance (`ClientResponseModel`) tiene:
- Un **código de empresa** (`CodCom`) → es el `OriginId` de la `Company` en Shopify.
- Un array de **direcciones** (`LocationResponseModel`) → cada dirección es a la vez:
  - Una `Location` (sucursal) en Shopify, con su propia dirección postal.
  - Un `Contact` (contacto) en Shopify, con email y teléfono.

El email de la persona de contacto de cada dirección se usa como `OriginId` único del contacto en Shopify.

### Por qué hay dos actividades Mirror al inicio

`SyncCompanies` y `SyncPriceLists` corren **antes del Extract** precisamente para que la TransactionsDB esté completamente actualizada cuando `CustomerDecision` compare los datos del ERP con ella.

- `SyncCompanies` reconcilia la jerarquía Company→Location→Contact→Role con el estado actual de Shopify. También procesa los clientes con etiquetas de agente (`IsAgent = true`) y los customers sin empresa.
- `SyncPriceLists` reconcilia las PriceLists con sus Catálogos y Publicaciones, y actualiza la tabla `PriceListsVariants`.

### `CustomerDecision` — La decisión de clientes

Gestiona decisiones independientes para los tres niveles jerárquicos. Para cada empresa del ERP:
- Busca si existe en la TransactionsDB por `OriginId` (= `CodCom`).
- Si existe: va a la lista de actualizar o a la de borrar según el estado.
- Si no existe: va a la lista de crear.

Hace lo mismo para cada Location (identificada por `ExternalId`) y cada Contact (identificado por email). Además gestiona la asignación de contacto principal (`MainContactAssign`) y los roles de acceso (`AssignRoles`).

La lógica `TryAddRole()` deduplica roles usando un `HashSet<string>` sembrado con los roles ya existentes en BD — evita crear el mismo rol dos veces si hay datos inconsistentes.

### `CompaniesWithContactsLoader` — Las 17 operaciones

El orden de ejecución es crítico. Siempre se borra antes de crear, y las companies antes que las locations, y las locations antes que los contacts:

| # | Operación | Nota |
|---|---|---|
| 1 | Revocar roles | Desasocia roles de contactos |
| 2 | Borrar contactos | Los agentes se omiten aunque estén en la lista |
| 3 | Borrar sucursales | |
| 4 | Borrar empresas | Primero desasocia contactos (requisito de la API) |
| 5 | Crear empresas | Incluye primera location y contactos en la misma llamada |
| 6 | Actualizar empresas | |
| 7 | Crear sucursales | En paralelo |
| 8 | Actualizar sucursales | |
| 9 | Actualizar configuración fiscal | |
| 10 | Actualizar direcciones | |
| 11 | Crear contactos | Si el customer ya existe por email, se reasigna |
| 12 | Actualizar contactos | |
| 13 | Añadir etiquetas a customers | Solo añade las que faltan |
| 14 | Asignar contacto principal | |
| 15 | Crear metafields | En lotes de 25 |
| 16 | Actualizar PriceLists y Markets | En lotes de 250 sucursales |
| 17 | Asignar roles | |

---

## 4. Workflow de Pedidos

**Fichero**: `ElsaServer/Workflows/OrdersWorkflow.cs`
**Dirección**: Shopify → API de Provalliance (dirección INVERSA al resto)
**Propósito**: Enviar los pedidos B2B de Shopify al ERP de Provalliance y marcarlos como sincronizados.

### Este workflow va en sentido contrario

Es el único workflow donde Shopify es el **origen** y Provalliance el **destino**. Representa el flujo natural de negocio: un cliente hace un pedido en la tienda online, y ese pedido tiene que llegar al sistema de gestión interno.

No hay actividad Mirror porque no se escribe en Shopify de forma estructurada — solo se añade una etiqueta al final. No hay actividad Decision porque todos los pedidos nuevos se envían siempre.

### Grafo del workflow

```
╔══════════════════════════════════════════════════════╗
║  EXTRACT                                             ║
║  OrdersExtractor                                     ║
║  └── Consulta Shopify: pedidos sin "Sincronizado"   ║
║  └── Solo pedidos B2B de companies                  ║
╚══════════════════════════════════════════════════════╝
                        ↓
╔══════════════════════════════════════════════════════╗
║  TRANSFORM                                           ║
║  OrderTransform                                      ║
║  └── Convierte pedido Shopify → formato ERP         ║
╚══════════════════════════════════════════════════════╝
                        ↓
╔══════════════════════════════════════════════════════╗
║  LOAD (en el ERP)                                    ║
║  LoadOrders                                          ║
║  └── Envía cada pedido al endpoint del ERP          ║
║  └── Si falla un pedido, continúa con el siguiente  ║
║  └── Los pedidos fallidos no se etiquetan            ║
╚══════════════════════════════════════════════════════╝
                        ↓
╔══════════════════════════════════════════════════════╗
║  LOAD (en Shopify)                                   ║
║  OrdersLoader                                        ║
║  └── Añade la etiqueta "Sincronizado" en Shopify    ║
║  └── También puede: crear pagos manuales, cancelar, ║
║      marcar como pagado, crear fulfillments y       ║
║      eventos de fulfillment                         ║
╚══════════════════════════════════════════════════════╝
```

### Cómo se evita procesar el mismo pedido dos veces

El filtro de pedidos está en `appsettings.json`:

```json
"FilterOrders": {
  "query": "tag_not:Sincronizado"
}
```

El extractor solo recupera pedidos que **no tengan** esa etiqueta. Cuando un pedido se envía correctamente al ERP, `LoadOrders` lo añade a la lista de pedidos a etiquetar, y finalmente `OrdersLoader` pone la etiqueta en Shopify. En la siguiente ejecución ese pedido ya no aparece.

### Capacidades completas de `OrdersLoader`

Aunque en el flujo habitual solo añade etiquetas, el loader puede ejecutar múltiples operaciones sobre pedidos según lo que configure el workflow:

| Operación | Cuándo |
|---|---|
| Añadir etiquetas | Siempre (marca "Sincronizado") |
| Crear pago manual | Cuando el ERP confirma el pago fuera de Shopify |
| Cancelar pedidos | Cuando el ERP rechaza el pedido |
| Marcar como pagado | Cuando el ERP confirma el cobro |
| Crear fulfillments | Cuando el ERP notifica el envío. Requiere recuperar el `FulfillmentOrderId` de Shopify primero. |
| Crear eventos de fulfillment | Cambios de estado: en tránsito, entregado, etc. Requiere el `FulfillmentId`. |

### Gestión de errores en `LoadOrders`

Si el envío de un pedido concreto al ERP falla, la actividad:
1. Registra el error en la BD de transacciones con el mensaje de error.
2. Loguea el error y lo añade a los logs de notificación.
3. **Continúa con el siguiente pedido** — un fallo en un pedido no para el proceso completo.

Los pedidos fallidos no se etiquetan como "Sincronizado", por lo que volverán a intentarse en la próxima ejecución.

---

## 5. Workflow de Imágenes PIM

**Fichero**: `ElsaServer/Workflows/ImagenesPIMWorkflow.cs`
**Dirección**: FTP → SalesLayer (PIM)
**Propósito**: Leer imágenes desde un servidor FTP y publicarlas en el PIM para que queden disponibles para los productos.

### Grafo del workflow

```
LocalImagesExtractor  →  Finish
```

### Lo que hace `LocalImagesExtractor`

1. Se conecta al servidor **FTP** configurado en `appsettings.json` (host, puerto, credenciales).
2. Descarga el listado de ficheros de las carpetas remotas configuradas.
3. Para cada imagen, extrae la **referencia** y el **orden** a partir del nombre del fichero. El convenio es `REFERENCIA-ORDEN.ext`, por ejemplo `GHD001-1.jpg` → referencia `GHD001`, orden `1`.
4. Genera un fichero **CSV** con la lista de nombres de imágenes (columna `Imagen`).
5. Sube ese CSV al mismo FTP en la ruta `CSV_CargaImages.csv`.

El PIM (SalesLayer) tiene configurado leer ese CSV periódicamente para asociar las imágenes a los productos correspondientes.

> Este workflow termina en `Finish` sin hacer más. La carga de las imágenes a Shopify la realiza el workflow de Imágenes Shopify.

---

## 6. Workflow de Imágenes Shopify

**Fichero**: `ElsaServer/Workflows/ImagenesShopifyWorkflow.cs`
**Dirección**: SalesLayer (PIM) → Shopify
**Propósito**: Sincronizar las imágenes de los productos del PIM en Shopify.

### Grafo del workflow

```
╔════════════════════════════════════════════════════════════════╗
║  MIRROR                                                        ║
║  SyncProductMedias                                             ║
║  └── Lee todos los productos+variantes+imágenes de Shopify    ║
║  └── Recupera el OriginId del campo ALT de cada imagen        ║
║  └── Actualiza la tabla Medias en TransactionsDB              ║
║  └── Sincroniza la asignación imagen↔variante en BD          ║
╚════════════════════════════════════════════════════════════════╝
                              ↓
╔════════════════════════════════════════════════════════════════╗
║  EXTRACT                                                       ║
║  ProductsWithImagesExtract                                     ║
║  └── Extrae productos E imágenes del PIM (misma actividad     ║
║      que en el workflow de Productos, salida "imágenes")      ║
╚════════════════════════════════════════════════════════════════╝
                              ↓
╔════════════════════════════════════════════════════════════════╗
║  DECISION                                                      ║
║  ImageDecision                                                 ║
║  └── 5 salidas: imagenesCrear / imagenesEditar /             ║
║      imagenesBorrar / imagenesAsociar / imagenesDesasociar   ║
╚════════════════════════════════════════════════════════════════╝
                              ↓
╔════════════════════════════════════════════════════════════════╗
║  TRANSFORM                                                     ║
║  ImagesTransform                                               ║
║  └── Convierte IProductImage → inputs de Shopify API         ║
╚════════════════════════════════════════════════════════════════╝
                              ↓
╔════════════════════════════════════════════════════════════════╗
║  LOAD                                                          ║
║  ProductsMedias                                                ║
║  └── Sube nuevas imágenes, incrustando OriginId en el ALT    ║
║  └── Actualiza imágenes existentes (preservando OriginId)    ║
║  └── Borra imágenes eliminadas                                ║
║  └── Asocia/desasocia imágenes de variantes                  ║
║  └── Reordena imágenes según Position                         ║
╚════════════════════════════════════════════════════════════════╝
                              ↓
╔════════════════════════════════════════════════════════════════╗
║  MIRROR POST-LOAD (opcional)                                   ║
║  MirrorMediasLoad                                              ║
║  └── Recibe la asignación imagen→variante desde el PIM       ║
║  └── Lee el estado de Shopify y hace el matching con el PIM  ║
║  └── Registra el par OriginId↔DestinoId en BD               ║
║  └── A diferencia de SyncProductMedias: usa datos del PIM   ║
║      para hacer el matching (no solo lo que hay en Shopify)  ║
╚════════════════════════════════════════════════════════════════╝
```

### Reutilización de `ProductsWithImagesExtract`

La misma actividad extrae tanto los productos (para el workflow de Productos) como las imágenes (para este workflow). Tiene dos salidas independientes:

```csharp
// En ProductsWorkflow — solo usa los productos:
["extraccionProductos"] = new ProductsWithImagesExtract
{
    ProductsOutput = new(variables["productos"]),
    ProductsImagesOutput = new()   // ← ignorado aquí
},

// En ImagenesShopifyWorkflow — solo usa las imágenes:
["extraccion"] = new ProductsWithImagesExtract
{
    ProductsOutput = new(),        // ← ignorado aquí
    ProductsImagesOutput = new(variables["imagenes"])
}
```

### Por qué el `OriginId` se guarda en el campo ALT de la imagen

El campo ALT (texto alternativo) es el único campo de texto libre que Shopify incluye en las respuestas de la API de imágenes del Bulk. Al guardar el `OriginId` en el ALT, `SyncProductMedias` puede recuperar ese identificador cuando lea las imágenes de Shopify para reconciliar la BD — sin necesidad de metafields.

El `ALT` no pierde el `OriginId` aunque se actualice la imagen porque `ProductsMedias.UpdateMedias()` recupera el `OriginId` de la BD antes de actualizar para reincrustarlo.

### Dos Mirror: ¿cuándo se usa cada uno?

| Mirror | Cuándo corre | Qué información tiene |
|---|---|---|
| `SyncProductMedias` | Al inicio del workflow | Solo lo que existe en Shopify (lee el ALT para recuperar OriginId) |
| `MirrorMediasLoad` | Después del Load (opcional) | Tiene además la asignación imagen→variante del PIM, hace matching más preciso |

### `ImageDecision` — Las 5 operaciones

Las imágenes no solo se crean o borran: también pueden **asociarse** o **desasociarse** de variantes específicas dentro de un producto. Por eso la decisión produce cinco tipos de salida:

| Canal | Qué representa |
|---|---|
| `imagenesCrear` | Imágenes nuevas que hay que subir a Shopify |
| `imagenesEditar` | Imágenes que ya existen pero cuya URL ha cambiado |
| `imagenesBorrar` | Imágenes que ya no están en el PIM |
| `imagenesAsociar` | Relaciones imagen-variante que hay que crear |
| `imagenesDesasociar` | Relaciones imagen-variante que hay que eliminar |

Nota: si una imagen va a borrarse, no se genera también una operación de desasociación de variante (sería redundante y podría dar error al intentar desasociar algo que ya no existe).

---

## Siguiente paso

Ya conoces qué hace cada workflow en detalle, incluyendo la capa Mirror y la capa Loader. El siguiente documento entra en detalle en la capa de extracción: cómo se autentican las APIs externas, cómo se pagina la respuesta de clientes y cómo se estructuran los modelos de datos que producen los extractors.

→ [04 — Los Extractors](04-extractors.md)

Para entender en detalle cómo funcionan los Loaders y las actividades Mirror, consulta:

→ [10 — Loaders y Mirror](10-loaders.md)
