---
tags:
  - Workflows
  - Procesos
  - Imágenes
  - PIM
  - Shopify
---

# WF-06 — Imágenes Shopify: Detalle completo

---

## Índice

1. [Actividad 1 — SyncProductMedias](#1-actividad-syncproductmedias)
2. [Actividad 2 — ProductsWithImagesExtract](#2-actividad-productswithimagesextract)
3. [Actividad 3 — ImageDecision](#3-actividad-imagedecision)
4. [Actividad 4 — ImagesTransform](#4-actividad-imagestransform)
5. [Actividad 5 — ProductsMedias](#5-actividad-productsmedias)
6. [Modelo IProductImage](#6-modelo-iproductimage)
7. [Operaciones sobre medias](#7-operaciones-sobre-medias)
8. [Notas de diseño](#8-notas-de-diseno)

---

## 1. Actividad: `SyncProductMedias`

**Clase:** `SyncProductMedias` *(Loaders.Shopify.Mirror — proyecto externo)*
**Tipo:** Mirror

Realiza una bulk query de Shopify para leer todas las medias (imágenes) de todos los productos y las sincroniza en `TransactionsDB.Products.Medias`. Construye la tabla de correspondencias `imageOriginId (URL) ↔ shopifyMediaId`.

Esta sincronización es esencial para que `ImagesTransform` pueda resolver los IDs de Shopify de las imágenes a actualizar y desasociar.

---

## 2. Actividad: `ProductsWithImagesExtract`

**Clase:** `ProductsWithImagesExtract`
**Fichero:** `Extractors/ProductsWithImagesExtract.cs`
**Hereda de:** `BaseActivity<ProductsWithImagesExtract>`

Esta actividad es **compartida** con el workflow de Productos. Aquí se usa con la configuración:

```csharp
new ProductsWithImagesExtract
{
    ProductsOutput    = new(),             // ignorado (salida vacía)
    ProductsImagesOutput = new(variables["imagenes"])  // usado
}
```

Solo el output de imágenes (`ProductsImagesOutput`) se conecta a una variable. El output de productos se descarta.

### Output usado en este workflow

| Variable | Tipo | Descripción |
|---|---|---|
| `imagenes` | `Box<IProductImage>` | Todas las imágenes de todos los productos del PIM |

---

## 3. Actividad: `ImageDecision`

**Clase:** `ImageDecision` *(Loaders.Shopify.Mirror — proyecto externo)*
**Tipo:** Decision

Compara el estado del PIM (`imagenes`) con el estado de Shopify (`TransactionsDB.Medias`) y clasifica cada imagen en una de las siguientes categorías:

### Outputs de la decisión

| Variable | Tipo | Descripción |
|---|---|---|
| `imagenesCrear` | `Box<IProductImage>` | Imágenes en PIM que no existen en Shopify → crear |
| `imagenesEditar` | `Box<IProductImage>` | Imágenes en PIM que ya existen pero cambiaron → actualizar |
| `imagenesBorrar` | `Box<string>` | OriginIds de imágenes en Shopify que ya no existen en PIM → borrar |
| `imagenesAsociar` | `Box<(ProductOriginId, VariantOriginId, ImageOriginId)>` | Asociaciones variante↔media nuevas |
| `imagenesDesasociar` | `Box<(ProductOriginId, VariantOriginId, ImageOriginId)>` | Asociaciones variante↔media a eliminar |

---

## 4. Actividad: `ImagesTransform`

**Clase:** `ImagesTransform`
**Fichero:** `Transformers/ImagesTransform.cs`
**Hereda de:** `BaseActivity<ImagesTransform>`

### ShouldRunAsync

```csharp
protected override bool ShouldRunAsync() =>
    _productsImagesCreate.Count > 0 ||
    _productsImagesUpdate.Count > 0 ||
    _productsImagesDelete.Count > 0 ||
    _appendMedias.Count > 0 ||
    _detachMedias.Count > 0;
```

Se ejecuta si hay alguna operación pendiente en cualquiera de los 5 canales.

### Proceso interno

El transformer resuelve los OriginIds de productos, variantes y medias hacia sus ShopifyIds consultando TransactionsDB, y construye las estructuras de datos que el loader necesita:

| Operación | Resolución |
|---|---|
| `Create` | `productOriginId → shopifyProductId` para agrupar medias por producto |
| `Update` | `imageOriginId (URL) → shopifyMediaId` para actualizar por Id |
| `Delete` | Sin resolución — son OriginIds directos |
| `Append` | `productOriginId → shopifyProductId` + `variantOriginId → shopifyVariantId` |
| `Detach` | `productOriginId`, `variantOriginId` y `imageOriginId → shopifyMediaId` |

Los productos, variantes o medias sin ShopifyId en TransactionsDB generan un `LogWarning` y se descartan de la operación (nunca lanzan excepción).

### Output

| Variable | Tipo | Descripción |
|---|---|---|
| `inputLoader` | `ProductsMediasLoaderInput` | Instrucciones completas para `ProductsMedias` |

### `ProductsMediasLoaderInput`

```csharp
{
    CreateMedias: Dictionary<string, List<OriginInput<IProductMedia>>>,
    // key: shopifyProductId
    
    UpdateMedias: List<IProductMedia>,
    // IProductMedia con Id Shopify ya resuelto
    
    Delete: string[],
    // OriginIds (URLs) de medias a borrar
    
    AppendMedias: Dictionary<string, List<(string variantId, string mediaId)>>,
    // key: shopifyProductId → lista de (variantShopifyId, imageOriginId)
    
    DetachMedias: Dictionary<string, List<(string VariantId, string MediaId)>>,
    // key: shopifyProductId → lista de (variantShopifyId, mediaShopifyId)
    
    PublishProductsWithMedias: true
}
```

### Logs de resultado

```text
Transformadas {N} medias para crear.
Transformadas {M} medias para actualizar.
Transformadas {K} medias para borrar.
Transformados {A} productos con medias a asociar.
Transformados {D} productos con medias a desasociar.
```

---

## 5. Actividad: `ProductsMedias`

**Clase:** `ProductsMedias` *(Loaders.Shopify.Products — proyecto externo)*
**Tipo:** Loader

Recibe `ProductsMediasLoaderInput` y ejecuta las operaciones sobre las medias de Shopify en el siguiente orden:

1. **Crear** medias nuevas (mutación `productCreateMedia`)
2. **Actualizar** medias existentes (mutación `productUpdateMedia`)
3. **Borrar** medias eliminadas (mutación `productDeleteMedia`)
4. **Asociar** medias a variantes (`productVariantAppendMedia`)
5. **Desasociar** medias de variantes (`productVariantDetachMedia`)
6. **Publicar** productos modificados si `PublishProductsWithMedias = true`

---

## 6. Modelo: `IProductImage`

**Namespace:** `ElsaShared.Interfaces`

Interfaz implementada por el modelo de imagen del PIM.

| Propiedad | Descripción |
|---|---|
| `ImageOriginId` | URL de la imagen en el PIM. Actúa como identificador único de origen |
| `ProductOriginId` | OriginId del producto al que pertenece la imagen |
| `VariantOriginId` | OriginId de la variante (si es imagen de variante). Nulo para imágenes de producto |
| `Position` | Posición de la imagen en la galería |

> La URL actúa como `OriginId` de la imagen porque es el identificador estable en el PIM. Si la URL cambia, se considera que la imagen ha cambiado.

---

## 7. Operaciones sobre medias

El sistema de imágenes de Shopify separa dos conceptos:

| Concepto | Descripción |
|---|---|
| **Media** | La imagen en sí: fichero subido a Shopify con su propia URL y `mediaId` |
| **Asociación variante↔media** | Enlace entre una variante específica y una media ya subida |

Por eso hay **5 tipos de operación** en lugar de 3 (crear/editar/borrar):

```text
Crear media          → sube la imagen al CDN de Shopify
Editar media         → reemplaza la URL (si el PIM cambió la imagen)
Borrar media         → elimina la imagen del CDN
Asociar variante     → vincula una media existente a una variante
Desasociar variante  → elimina el vínculo variante↔media (no borra la media)
```

---

## 8. Notas de diseño

### Extractor compartido con Productos

`ProductsWithImagesExtract` recupera tanto productos como imágenes en una sola llamada al PIM. Cada workflow usa la mitad que le interesa:
- **Productos** → usa `ProductsOutput`, ignora `ProductsImagesOutput`
- **Imágenes Shopify** → usa `ProductsImagesOutput`, ignora `ProductsOutput`

Esto evita duplicar la llamada al PIM cuando ambos workflows se ejecutan por separado.

### Condición de carrera detectada en el transformer

`ImagesTransform` registra un `LogError` específico para un caso edge:

```text
No se ha encontrado el Id de Shopify para actualizar la imagen {id}.
Esto no debería haber ocurrido (salvo condición de carrera), revisar DECISIÓN.
```

Si la decisión clasifica una imagen como "actualizar" pero el Mirror no tiene su ShopifyId, puede indicar que el Mirror está desactualizado o que hubo una inconsistencia en el proceso.
