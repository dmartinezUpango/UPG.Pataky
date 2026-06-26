---
tags:
  - Decisions
  - ERP
  - PIM
---

# 04d — Los Decisions

Los Decisions son la segunda fase de la capa de extracción: reciben los datos que acaban de llegar del sistema origen y los **clasifican** en operaciones concretas para Shopify (crear, actualizar, borrar). No transforman ningún campo ni llaman a ninguna API externa — solo consultan la **BD de transacciones** y comparan.

> **¿Quieres ver el código completo de un método?**
> → [`04d-decisions-metodos.md`](04d-decisions-metodos.md) — cada `RunAsync` explicado con su código fuente completo.

---

## El problema que resuelven

Después de que los extractors entregan los datos del ERP o del PIM, el sistema tiene una lista completa de *cómo deberían estar las cosas*. Pero Shopify ya tiene su propio estado. El Decision responde a la pregunta:

> *¿Qué hay que hacer para que Shopify quede igual que el origen?*

Para responder esa pregunta, compara la lista entrante contra la **BD de transacciones** (`transactions-provalliance`), que registra cada entidad sincronizada con su `OriginId` (código del ERP/PIM) y su `DestinoId` (ID de Shopify).

```text
Sistema origen          Decision                    Outputs para los transformers
──────────────          ────────────────────────    ──────────────────────────────
Lista completa     →    Existe en BD?               → Crear (no estaba)
de entidades            · No  →  Crear              → Actualizar (ya estaba)
actuales                · Sí  →  Actualizar         → Borrar (estaba pero ya no llega)
                        Está en BD pero no
                        en la lista?  →  Borrar
```

---

## Contrato común: la herencia de `BaseActivity<T>`

Todos los Decisions son actividades de Elsa que heredan de [`BaseActivity<T>`](04c-extractors-metodos.md#1-infraestructura-base-de-una-actividad), igual que los extractors y los transformers. El contrato es el mismo:

| Método | Rol |
|---|---|
| `InitInputs` | Lee los inputs del contexto de Elsa y los guarda en campos privados |
| `ShouldRunAsync` | Devuelve `false` si no hay nada que procesar (lista vacía) |
| `RunAsync` | Consulta la BD, clasifica, y escribe los outputs |

El patrón típico de `ShouldRunAsync` en los Decisions:

```csharp
protected override bool ShouldRunAsync() => _productos is { Count: > 0 };
```

Si el extractor previo no entregó ningún elemento, el Decision se salta por completo y los transformers recibirán listas vacías.

---

## Los 5 Decisions del sistema

### 1. ProductsDecision — comparación básica de productos

**Fichero:** `UPG.Pataky.Shared/.../Decisions/ProductDecision.cs`
**Usado en:** Workflow de Productos (versión base)

Recibe la lista completa de productos y variantes del PIM y produce seis listas de trabajo.

| Input | Tipo |
|---|---|
| `ProductosInput` | `Box<IProduct>` — todos los productos del PIM |

| Output | Tipo | Contenido |
|---|---|---|
| `ProductosCrear` | `Box<IProduct>` | Productos que no existen en BD → hay que crearlos en Shopify |
| `ProductosActualizar` | `Box<IProduct>` | Productos que ya existen en BD → hay que actualizarlos |
| `ProductosBorrar` | `Box<string>` | OriginIds de productos que estaban en BD pero no han llegado del PIM |
| `VariantesCrear` | `Box<IVariant>` | Variantes de productos ya existentes que son nuevas |
| `VariantesActualizar` | `Box<IVariant>` | Variantes que ya existen en BD → actualizar |
| `VariantesBorrar` | `Box<string>` | OriginIds de variantes que estaban en BD pero ya no llegan del PIM |

**Lógica:** consulta la BD elemento a elemento. Para cada producto, llama a `ExistsProductByOriginId`; para cada variante de un producto existente, llama a `ExistsVariantByOriginId`. El diff de borrados se calcula al final comparando todos los OriginIds de BD contra el input.

→ [Ver `RunAsync` completo](04d-decisions-metodos.md#1-productsdecision-runasync)

---

### 2. ProductsRebuildDecision — con reconstrucción de opciones

**Fichero:** `UPG.Pataky.Shared/.../Decisions/ProductsRebuildDecision.cs` y `Decisions/ProductsRebuildDecision.cs`
**Usado en:** Workflow de Productos (versión actual)

Versión mejorada de `ProductsDecision`. Añade un séptimo output y cuatro capacidades nuevas.

| Input | Tipo |
|---|---|
| `ProductosInput` | `Box<IProduct>` — todos los productos del PIM |

| Output | Tipo | Contenido |
|---|---|---|
| `ProductosCrear` | `Box<IProduct>` | Productos nuevos |
| `ProductosActualizar` | `Box<IProduct>` | Productos a actualizar |
| `ProductosBorrar` | `Box<string>` | Productos desaparecidos |
| `VariantesCrear` | `Box<IVariant>` | Variantes nuevas |
| `VariantesActualizar` | `Box<IVariant>` | Variantes a actualizar |
| `VariantesBorrar` | `Box<string>` | Variantes desaparecidas |
| **`RebuildProductOptions`** | `Box<IProduct>` | **Productos cuyo esquema de opciones ha cambiado** |

**Las cuatro capacidades adicionales:**

| Capacidad | Qué hace |
|---|---|
| Detección de cambio de opciones | Si [`GetSortedOptions()`](04c-extractors-metodos.md#getsortedoptions) del producto actual difiere del esquema guardado en BD, el producto va a `RebuildProductOptions` en lugar de `ProductosActualizar` |
| Límite de variantes (`MaxNumVariants = 2048`) | Los productos que superan 2048 variantes se descartan antes de clasificar y se loguea un error |
| Promoción a borrado de producto | Si todas las variantes de un producto van a borrarse, se promueve a borrar el producto entero en lugar de N variantes individuales |
| Supresión de borrado de variantes redundante | Si el producto padre ya va a borrarse, sus variantes se eliminan de `VariantesBorrar` (Shopify las borra automáticamente al borrar el producto) |

**Por qué existe `RebuildProductOptions`:** Shopify no permite actualizar las opciones de un producto directamente. Cuando el esquema de opciones cambia (ej: el producto pasa de tener "Color + Talla" a solo "Color"), hay que usar una operación especial de reconstrucción que borra y vuelve a crear todas las opciones y variantes. El transformer `ProductsUpdateTransform` detecta esta lista y genera esa operación.

→ [Ver `RunAsync` completo con las 4 capacidades explicadas](04d-decisions-metodos.md#2-productsrebuilddecision-runasync)

---

### 3. CustomerDecision — jerarquía a tres niveles

**Fichero:** `UPG.Pataky.Shared/.../Decisions/CustomerDecision.cs`
**Usado en:** Workflow de Clientes

El más complejo de los cinco. Gestiona la jerarquía B2B completa: una `Company` tiene `Location`s (sucursales), y cada `Location` tiene `Customer`s (contactos). Además gestiona la asignación de roles (qué contactos pueden actuar en qué sucursales) y el contacto principal.

| Input | Tipo |
|---|---|
| `CompaniesInput` | `Box<ICompany>` — lista completa de clientes del ERP |

| Output | Tipo | Contenido |
|---|---|---|
| `CreateCompanies` | `Box<ICompany>` | Companies nuevas (con todas sus locations y contacts) |
| `UpdateCompanies` | `Box<(DestinoId, ICompany)>` | Companies a actualizar (con su ID de Shopify) |
| `DeleteCompanies` | `Box<string>` | DestinoIds de companies a borrar |
| `CreateLocations` | `Box<(DestinoId, ILocation)>` | Sucursales nuevas (con el DestinoId de su company padre) |
| `UpdateLocations` | `Box<(DestinoId, ILocation)>` | Sucursales a actualizar (con su DestinoId) |
| `DeleteLocations` | `Box<Location>` | Objetos Location a borrar (con DestinoId incluido) |
| `CreateContacts` | `Box<(DestinoId, ICustomer)>` | Contactos nuevos (con el DestinoId de su company) |
| `UpdateContacts` | `Box<(DestinoId, ICustomer)>` | Contactos a actualizar (con su DestinoId de CompanyContact) |
| `DeleteContacts` | `Box<string>` | DestinoIds de contactos a borrar |
| `MainContactAssign` | `Box<(DestinoId, ICustomer)>` | Asignaciones de contacto principal que han cambiado |
| `AssignRoles` | `Box<(ICustomer, ILocation)>` | Pares contacto-sucursal a los que asignar rol en Shopify B2B |

**Puntos clave de la lógica:**

- Cada `DestinoId` que llega en los outputs de actualización/borrado proviene de la BD de transacciones — los transformers lo necesitan para llamar a las mutaciones correctas de la API de Shopify.
- [`TryAddRole`](04d-decisions-metodos.md#tryaddrole) evita duplicados usando un `HashSet` de OriginIds de roles ya existentes. Un contacto puede aparecer tanto en `company.GetCustomers()` como en `location.GetCustomers()` — sin este control se generarían asignaciones de rol duplicadas.
- Los contactos de empresa marcados como `IsAgent` nunca se borran automáticamente.
- El `MainContactAssign` solo se rellena si el contacto principal del ERP difiere del que está registrado en la BD.

→ [Ver `RunAsync` completo con diagrama de jerarquía](04d-decisions-metodos.md#3-customerdecision-runasync)

---

### 4. ImageDecision — imágenes y sus asignaciones

**Fichero:** `UPG.Pataky.Shared/.../Decisions/ImageDecision.cs`
**Usado en:** Workflow de Imágenes

Clasifica imágenes en tres operaciones básicas y dos operaciones de asociación variante-imagen.

| Input | Tipo |
|---|---|
| `ProductsImagesInput` | `Box<IProductImage>` — todas las imágenes del PIM |

| Output | Tipo | Contenido |
|---|---|---|
| `ProductsImagesCreate` | `Box<IProductImage>` | Imágenes nuevas (URL no está en BD) |
| `ProductsImagesUpdate` | `Box<IProductImage>` | Imágenes existentes cuya metadata puede haber cambiado |
| `ProductsImagesDelete` | `Box<string>` | DestinoIds de medias a borrar (URL desaparecida del PIM) |
| `AppendMedias` | `Box<(ProductOriginId, VariantOriginId, ImageOriginId)>` | Asociaciones variante-imagen a crear |
| `DetachMedias` | `Box<(ProductOriginId, VariantOriginId, ImageOriginId)>` | Asociaciones variante-imagen a eliminar |

**Por qué son necesarios `AppendMedias` y `DetachMedias`:**

En Shopify B2B, cada variante puede tener su propia imagen. Cuando el PIM cambia qué imagen está asignada a qué variante, no es suficiente con actualizar la imagen — hay que gestionar explícitamente las asociaciones. El Decision calcula el estado deseado (qué imagen debe tener cada variante según el PIM) y el estado actual (qué imagen tiene cada variante según la BD) y produce las diferencias.

La lógica guarda que si una imagen ya va a borrarse (`imageOriginIdsToDelete`), no se genera operación de desasociación para esa imagen — Shopify la desasocia automáticamente al borrarla.

→ [Ver `RunAsync` completo con la lógica de AppendMedias/DetachMedias](04d-decisions-metodos.md#4-imagedecision-runasync)

---

### 5. PriceListDecision — tarifas B2B

**Fichero:** `UPG.Pataky.Shared/.../Decisions/PriceListDecision.cs`
**Usado en:** Workflow de Clientes (sincronización de tarifas)

El más simple. Clasifica tarifas de precio B2B en tres operaciones.

| Input | Tipo |
|---|---|
| `PriceLists` | `Box<IPriceList>` — tarifas del ERP |

| Output | Tipo | Contenido |
|---|---|---|
| `PriceListsCrear` | `Box<IPriceList>` | Tarifas nuevas (OriginId no está en BD) |
| `PriceListsEditar` | `Box<IPriceList>` | Tarifas que ya existen en BD |
| `PriceListsEliminar` | `Box<string>` | DestinoIds de tarifas que estaban en BD pero ya no llegan del ERP |

**El caso especial de `MarketCatalog`:** las tarifas de tipo `MarketCatalog` son catálogos de precios públicos que Shopify gestiona automáticamente. El ERP no los conoce, por lo que sin este filtro el Decision los añadiría siempre a `PriceListsEliminar`. Se excluyen del diff de borrados comprobando el prefijo del `CatalogId`.

→ [Ver `RunAsync` completo con el filtro de MarketCatalog](04d-decisions-metodos.md#5-pricelistdecision-runasync)

---

## Resumen: qué compara cada Decision y en base a qué

| Decision | Fuente de datos BD | Elementos comparados | Outputs |
|---|---|---|---|
| `ProductsDecision` | `Products` + `Variants` | OriginId de producto y variante | 6 |
| `ProductsRebuildDecision` | `Products` + `Variants` + `Options` | OriginId + esquema de opciones | 7 |
| `CustomerDecision` | `Companies` + `Locations` + `Contacts` + `Roles` | OriginId en cada nivel de jerarquía + MainContact | 11 |
| `ImageDecision` | `Medias` (con productos y variantes) | ImageOriginId (URL) + asignaciones variante-imagen | 5 |
| `PriceListDecision` | `PriceLists` | OriginId de tarifa (excluyendo MarketCatalog) | 3 |

---

## Siguiente paso

Con los datos clasificados, los transformers convierten los modelos del ERP/PIM al formato de la API de Shopify.

→ [05 — Los Transformers](05-transformers.md)

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [`04-extractors.md`](04-extractors.md) | Los extractors que producen los datos que reciben los Decisions |
| [`04c-extractors-metodos.md`](04c-extractors-metodos.md) | `BaseActivity<T>`, `GetSortedOptions()` y otros métodos referenciados |
| [`04d-decisions-metodos.md`](04d-decisions-metodos.md) | Código completo y explicación de cada `RunAsync` |
| [`05-transformers.md`](05-transformers.md) | Los transformers que reciben los outputs de los Decisions |
