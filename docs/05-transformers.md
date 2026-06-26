---
tags:
  - Transformers
  - Shopify
  - AutoMapper
---

# 05 — Los Transformers: visión general

Los transformers son la tercera capa del patrón ETL. Reciben los modelos **ya clasificados** por los [Decisions](04d-decisions.md) (listas separadas de qué crear, actualizar y borrar) y los convierten al formato que necesitan los loaders (inputs de la API de Shopify). No leen de ningún sistema externo, no escriben en ningún destino: **solo transforman**.

> **¿Quieres entender cómo funciona un método concreto?**
> → [`05c-transformers-metodos.md`](05c-transformers-metodos.md) — explicación paso a paso de cada función y método de esta capa.

Sin embargo, sí necesitan acceder a la **base de datos de transacciones** durante la transformación, porque necesitan resolver los `OriginId` (códigos del ERP o del PIM) a `DestinoId` (IDs de Shopify). Este es el papel fundamental de `TransactionsService` en la capa de transformación.

---

## El problema que resuelven los transformers

El sistema origen (ERP, PIM, FTP) habla un idioma: códigos de cliente, SKUs, URLs de imágenes.

Shopify habla otro idioma: IDs de GraphQL con formato `gid://shopify/Product/123456`, `gid://shopify/ProductVariant/789`, etc.

Los transformers son los traductores entre ambos mundos. Reciben un modelo como `ClientResponseModel` (en lenguaje del ERP) y producen un `CompanyInput` (en lenguaje de Shopify).

---

## La herramienta principal: AutoMapper

Tres de los transformers usan **AutoMapper**, una librería de .NET que permite declarar de forma explícita y reutilizable cómo mapear los campos de una clase a otra.

En lugar de escribir esto manualmente en cada transformer:

```csharp
var company = new CompanyInput
{
    ExternalId = cliente.Company.CodCom,
    Name = cliente.Company.Name,
    // ...
};
```

Se declara un **perfil de mapeo** una vez:

```csharp
CreateMap<ClientResponseModel, CompanyInput>()
    .ForMember(dest => dest.ExternalId, opt => opt.MapFrom(src => src.Company.CodCom))
    .ForMember(dest => dest.Name, opt => opt.MapFrom(src => src.Company.Name));
```

Y luego el transformer solo necesita:

```csharp
var company = mapper.Map<CompanyInput>(cliente);
```

Los tres perfiles de AutoMapper del proyecto son:
- [`CustomersMappingProfile`](05c-transformers-metodos.md#2-customersmappingprofile-mapeos-automapper) — clientes del ERP a estructuras B2B de Shopify
- [`OrdersMappingProfile`](05c-transformers-metodos.md#8-ordersmappingprofile-mapeos-automapper) — pedidos de Shopify al formato del ERP
- [`ProductosMappingTransforms`](05c-transformers-metodos.md#12-productosmappingtransforms-mapeos-automapper) — productos del PIM a inputs de producto/variante de Shopify

---

## El papel de `TransactionsService`

La BD de transacciones (`transactions-provalliance`) actúa como el **diccionario de traducción** entre los dos sistemas. Guarda pares `OriginId ↔ DestinoId` para cada entidad.

Todos los transformers la usan para resolver IDs antes de generar los inputs de Shopify:

```text
ERP/PIM                 BD Transacciones              Shopify
─────────────────       ──────────────────────        ─────────────────────────────────
Sku = "GHD001"    →     OriginId="GHD001"       →     DestinoId="gid://shopify/Product/123"
Ean = "8432..."   →     Referencia="8432..."    →     DestinoId="gid://shopify/ProductVariant/456"
CodCom = "C0001"  →     OriginId="C0001"        →     DestinoId="gid://shopify/Company/789"
```

Si no se puede encontrar un ID en la BD, el elemento se descarta con un log de warning o error. Nunca se asume un ID.

---

## Los transformers del sistema

El proyecto tiene 9 transformers. Algunos son simples (convierten directamente con AutoMapper) y otros son complejos (tienen lógica de resolución de IDs, detección de casos especiales, etc.).

### 1. `ProductsCreateTransform` — Crear productos en Shopify

**Fichero**: `Transformers/Products/ProductsCreateTransform.cs`
**Recibe**: productos y variantes marcados para crear
**Produce**: `ProductsWithVariantsCreateLoaderInput`

Convierte cada `Product` en un `ProductCreateInput` de Shopify usando `ProductosMappingTransforms`. Procesa dos tipos de creación:
- **Producto nuevo con sus variantes** (producto que no existía en absoluto en Shopify).
- **Variantes nuevas de un producto ya existente** (el producto padre ya existe, solo hay que añadirle variantes).

Descarta productos sin opciones definidas y variantes sin valores de opción.

### 2. `ProductsUpdateTransform` — Actualizar y archivar productos

**Fichero**: `Transformers/Products/ProductsUpdateTransform.cs`
**Recibe**: productos y variantes a actualizar, productos a archivar, productos con opciones a reconstruir
**Produce**: `ProductsWithVariantsUpdateLoaderInput`

Es el transformer más complejo de los productos. Gestiona cuatro operaciones distintas en una sola pasada:
- **Actualizar** datos del producto (título, descripción, metafields...).
- **Actualizar** variantes existentes (precio, EAN, opciones, galería de imágenes...).
- **Reconstruir opciones** (RebuildProductOptions): cuando cambia el esquema de variantes de un producto, hay que borrar las opciones antiguas y crearlas de nuevo.
- **Archivar**: cambia el estado del producto a `ARCHIVED` en Shopify y modifica el handle para evitar conflictos de URL.

El archivar requiere una llamada extra a Shopify para comprobar el estado actual del producto antes de intentar archivarlo (para no archivar algo que ya está archivado).

### 3. `ProductsDeleteTransform` — Borrar variantes

**Fichero**: `Transformers/Products/ProductsDeleteTransform.cs`
**Recibe**: OriginIds de productos y variantes a borrar
**Produce**: `ProductsWithVariantsDeleteLoaderInput` con los DestinoIds de Shopify

No usa AutoMapper. Su trabajo es resolver los OriginIds a DestinoIds a través de `TransactionsService` y organizar las variantes por producto (porque la API de Shopify para borrar variantes las agrupa por producto padre).

### 4. `StockTransform` — Stock del ERP a inventario de Shopify

**Fichero**: `Transformers/StockTransform.cs`
**Recibe**: lista de `Stock` (ean + warehouse + quantity)
**Produce**: `SyncStockInput`

Resuelve cada EAN al ID de variante de Shopify consultando la BD de transacciones. Si hay variantes en la BD que no aparecen en el stock del ERP, las establece a 0 (no han desaparecido del catálogo, solo no se han recibido — podría ser stock agotado).

### 5. `ImagesTransform` — Imágenes del PIM a medias de Shopify

**Fichero**: `Transformers/ImagesTransform.cs`
**Recibe**: cinco listas de operaciones de imagen (crear/actualizar/borrar/asociar/desasociar)
**Produce**: `ProductsMediasLoaderInput`

Es el transformer más complejo del sistema en cuanto a número de operaciones. Una imagen en Shopify no es simplemente un fichero: tiene relaciones con el producto y con las variantes específicas que la muestran. Por eso hay que gestionar cinco tipos de operaciones independientes.

### 6. `CustomerTransform` — Clientes del ERP a empresas B2B de Shopify

**Fichero**: `Transformers/CustomerTransform.cs`
**Recibe**: listas de companies/locations/contacts a crear y actualizar
**Produce**: `CompaniesWithContactsInput`

Usa `CustomersMappingProfile` para convertir los tres niveles de la jerarquía B2B. Añade metafields personalizados (zona fiscal, external_id) y gestiona la conversión de los códigos de país y provincia a los formatos ISO que espera Shopify.

### 7. `OrderTransform` — Pedidos de Shopify al formato del ERP

**Fichero**: `Transformers/OrderTransform.cs`
**Recibe**: lista de `Order` de Shopify
**Produce**: lista de `OrderModel` (header + líneas en formato ERP)

Usa `OrdersMappingProfile`. Descarta pedidos sin `ExternalId` (que es el código de cliente del ERP). Detecta si el pedido es un dropshipping (dirección de envío diferente a la de la sucursal) y en ese caso incluye la dirección completa en el modelo del ERP.

### 8. `PriceListTransform` — Tarifas de precio

**Fichero**: `Transformers/PriceListTransform.cs`
**Recibe**: tarifas a crear/actualizar/borrar
**Produce**: `PriceListsB2BLoaderInput`

Transformer de tarifas B2B de Shopify. Gestiona la lógica compleja de actualización incremental de precios por variante: compara lo que hay en la BD con lo que llega del ERP y calcula qué precios hay que añadir, actualizar, resetear o excluir de qué tarifas.

### 9. `TranslationsTransform` — Traducciones de contenido

**Fichero**: `Transformers/TranslationsTransform.cs`
**Recibe**: productos e ítems traducibles
**Produce**: `TranslationsInput`

Transforma el contenido multilingüe de los productos y metafields para su sincronización en Shopify. Soporta traducciones para productos, variantes, companies, locations y contacts. No está conectado a ningún workflow activo actualmente.

---

## Resumen: qué transforma cada transformer y cómo

| Transformer | De | A | Usa AutoMapper |
|---|---|---|---|
| `ProductsCreateTransform` | `Product` + `Variant` | `ProductCreateInput` + `ProductVariantsBulkInput` | Sí |
| `ProductsUpdateTransform` | `Product` + `Variant` + OriginIds archivar | `ProductUpdateInput` + `ProductVariantsBulkInput` | Sí |
| `ProductsDeleteTransform` | OriginIds | DestinoIds agrupados | No |
| `StockTransform` | `Stock` (ean+qty) | `SyncStockInput` | No |
| `ImagesTransform` | 5 listas de operaciones de imagen | `ProductsMediasLoaderInput` | No |
| `CustomerTransform` | `ICompany`/`ILocation`/`ICustomer` | `CompanyInput`/`CompanyLocationInput`/`CompanyContactInput` | Sí |
| `OrderTransform` | `Order` de Shopify | `OrderModel` (header+lines) | Sí |
| `PriceListTransform` | `IPriceList` | `PriceListsB2BLoaderInput` | No |
| `TranslationsTransform` | `ITranslatable` | `TranslationsInput` | No |

---

## Siguiente paso

El siguiente documento entra en profundidad en cada transformer: la lógica campo a campo, todos los metafields que se generan, cómo se calculan los descuentos y cómo se resuelven los IDs.

→ [05b — Transformers: detalle completo](05b-transformers-detalle.md)

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [`05b-transformers-detalle.md`](05b-transformers-detalle.md) | Estructura campo a campo de cada transformer: qué mapea, qué metafields genera |
| [`05c-transformers-metodos.md`](05c-transformers-metodos.md) | Explicación paso a paso de cada método y función de esta capa |
| [`10-loaders.md`](10-loaders.md) | Los Loaders que reciben los outputs de los Transformers y escriben en Shopify |
