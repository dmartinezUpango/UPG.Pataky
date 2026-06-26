---
tags:
  - Workflows
  - Procesos
  - Imágenes
  - PIM
  - Shopify
---

# WF-06 — Imágenes Shopify: Métodos y funciones

---

## Índice

1. [ImagesTransform — clase](#1-imagestransform-clase)
2. [InitInputs](#2-initinputs)
3. [ShouldRunAsync](#3-shouldrunasync)
4. [RunAsync — resolución de IDs de productos y medias](#4-runasync-resolucion-de-ids-de-productos-y-medias)
5. [RunAsync — construcción del output](#5-runasync-construccion-del-output)
6. [BuildAppendMedias](#6-buildappendmedias)
7. [BuildDetachMedias](#7-builddetachmedias)

---

## 1. `ImagesTransform` — clase

**Fichero:** `Transformers/ImagesTransform.cs`
**Namespace:** `Transformers`
**Hereda de:** `BaseActivity<ImagesTransform>`

```csharp
public class ImagesTransform : BaseActivity<ImagesTransform>
{
    [Input] public required Input<Box<IProductImage>> ProductsImagesCreate { get; init; }
    [Input] public required Input<Box<IProductImage>> ProductsImagesUpdate { get; init; }
    [Input] public required Input<Box<string>>        ProductsImagesDelete { get; init; }
    [Input] public required Input<Box<(string ProductOriginId, string VariantOriginId, string ImageOriginId)>> AppendMedias { get; init; }
    [Input] public required Input<Box<(string ProductOriginId, string VariantOriginId, string ImageOriginId)>> DetachMedias { get; init; }

    [Output] public required Output<ProductsMediasLoaderInput> Output { get; set; }
    ...
}
```

Recibe 5 inputs clasificados por `ImageDecision` y produce un único output estructurado para el loader.

---

## 2. `InitInputs`

```csharp title="ImagesTransform.cs"
protected override void InitInputs(ActivityExecutionContext context)
{
    _productsImagesCreate = context.Get(ProductsImagesCreate)!.Property.ToList();
    _productsImagesUpdate = context.Get(ProductsImagesUpdate)!.Property.ToList();
    _productsImagesDelete = context.Get(ProductsImagesDelete)!.Property.ToList();
    _appendMedias         = context.Get(AppendMedias)!.Property.ToList();
    _detachMedias         = context.Get(DetachMedias)!.Property.ToList();
}
```

Materializa los 5 `Box<T>` en listas. A partir de aquí el transformer trabaja solo con colecciones en memoria.

---

## 3. `ShouldRunAsync`

```csharp title="ImagesTransform.cs"
protected override bool ShouldRunAsync() =>
    _productsImagesCreate.Count > 0 ||
    _productsImagesUpdate.Count > 0 ||
    _productsImagesDelete.Count > 0 ||
    _appendMedias.Count > 0 ||
    _detachMedias.Count > 0;
```

Se ejecuta si hay **alguna** operación pendiente. Si la `ImageDecision` no clasificó nada (sin cambios), el transformer y el loader se omiten.

---

## 4. `RunAsync` — resolución de IDs de productos y medias

```csharp title="ImagesTransform.cs"
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var transactionService = context.GetRequiredService<TransactionsService>();

    var productOriginIds = _productsImagesCreate
        .Select(x => x.ProductOriginId)
        .Union(_productsImagesUpdate.Select(x => x.ProductOriginId))
        .Union(_appendMedias.Select(x => x.ProductOriginId))
        .Union(_detachMedias.Select(x => x.ProductOriginId))
        .ToHashSet(); // (1)!

    var productsOriginIdToShopifyId = productOriginIds.Count > 0
        ? await transactionService.Products.FindShopifyIds(productOriginIds)
        : new Dictionary<string, string?>();

    _productsImagesCreate
        .RemoveAllAndGetRemoved(x =>
            !productsOriginIdToShopifyId.TryGetValue(x.ProductOriginId, out var value) || value is null)
        .ForEach(x => _logger.LogWarning(
            "No se puede crear la imagen con URL {imgId} porque el producto {prodId} no existe en Shopify.",
            x.ImageOriginId, x.ProductOriginId)); // (2)!
```
1. Se calcula el conjunto mínimo de `productOriginIds` necesarios para una sola consulta a TransactionsDB, en lugar de una por operación.
2. Las imágenes cuyo producto no está en TransactionsDB (nunca sincronizado o eliminado) se retiran de la lista `_productsImagesCreate` antes de construir el output, y se registra un `LogWarning`. Sin esta limpieza, el loader fallería al intentar asociar la imagen a un producto sin ShopifyId.

---

## 5. `RunAsync` — construcción del output

```csharp title="ImagesTransform.cs"
    var create = _productsImagesCreate
        .GroupBy(x => x.ProductOriginId)
        .ToDictionary(
            x => productsOriginIdToShopifyId[x.Key]!,  // (1)!
            x => x.Select((productImage, i) => new OriginInput<IProductMedia>
            {
                OriginId = productImage.ImageOriginId,  // (2)!
                Input = new ProductMediaUrl
                {
                    Url              = productImage.ImageOriginId,
                    MediaContentType = MediaContentType.IMAGE,
                    Position         = (uint)i
                }
            }).ToList());

    var productsMediasOriginIdToShopifyId = _productsImagesUpdate.Count > 0
        ? await transactionService.Products.Medias.FindShopifyIds(
            _productsImagesUpdate.Select(x => x.ImageOriginId).ToHashSet())
        : new Dictionary<string, string?>();

    var update = _productsImagesUpdate
        .GroupBy(x => x.ProductOriginId)
        .SelectMany(group => group.Select((x, i) => new ProductMediaUrl
        {
            Id               = productsMediasOriginIdToShopifyId.TryGetValue(x.ImageOriginId, out var value) ? value : null,
            Url              = x.ImageOriginId,
            MediaContentType = MediaContentType.IMAGE,
            Position         = (uint)i
        })).ToList();

    update.RemoveAllAndGetRemoved(x => x.Id is null)
        .ForEach(x => _logger.LogError(
            "No se ha encontrado el Id de Shopify para actualizar la imagen {id}. " +
            "Esto no debería haber ocurrido (salvo condición de carrera), revisar DECISIÓN.", x.Url)); // (3)!

    Output.Set(context, new ProductsMediasLoaderInput
    {
        CreateMedias            = create,
        UpdateMedias            = update.OfType<IProductMedia>().ToList(),
        Delete                  = _productsImagesDelete.ToArray(),
        AppendFiles             = null,
        AppendMedias            = append,
        DetachMedias            = detach,
        PublishProductsWithMedias = true // (4)!
    });
```
1. La clave del diccionario de creación es el `shopifyProductId`. El loader agrupa las operaciones de medias por producto.
2. La URL de la imagen sirve como `OriginId` — es el identificador estable de la media en el PIM. TransactionsDB la usará como `OriginId` para registrar la media creada.
3. Si una imagen clasificada como "actualizar" no tiene ShopifyId en TransactionsDB, se descarta con `LogError`. Esto **no debería** ocurrir en condiciones normales — indica que la `ImageDecision` y el Mirror están desincronizados (posible condición de carrera si otra instancia del workflow está corriendo en paralelo).
4. `PublishProductsWithMedias = true` indica al loader que publique (o republique) los productos modificados con la API `publishablePublish`. Garantiza que los productos cuyos cambios de media los dejaron en estado borrador vuelvan a estar visibles.

---

## 6. `BuildAppendMedias`

```csharp title="ImagesTransform.cs"
private Dictionary<string, List<(string variantId, string mediaId)>> BuildAppendMedias(
    Dictionary<string, string?> productsOriginIdToShopifyId,
    Dictionary<string, string?> productsVariantsOriginIdToShopifyId)
{
    // (1)! Loguear asociaciones cuyo producto o variante no tiene ShopifyId
    _appendMedias
        .Where(x => !productsOriginIdToShopifyId.TryGetValue(x.ProductOriginId, out var id) || string.IsNullOrWhiteSpace(id))
        .ToList()
        .ForEach(x => _logger.LogWarning(...));

    _appendMedias
        .Where(x => !productsVariantsOriginIdToShopifyId.TryGetValue(x.VariantOriginId, out var id) || string.IsNullOrWhiteSpace(id))
        .ToList()
        .ForEach(x => _logger.LogWarning(...));

    var append = _appendMedias
        .GroupBy(x => x.ProductOriginId)
        .Where(x => productsOriginIdToShopifyId.TryGetValue(x.Key, out var v) && !string.IsNullOrWhiteSpace(v))
        .ToDictionary(
            x => productsOriginIdToShopifyId[x.Key]!,
            x => x
                .Where(y => productsVariantsOriginIdToShopifyId.TryGetValue(y.VariantOriginId, out var v) && !string.IsNullOrWhiteSpace(v))
                .Select(y => (
                    variantId: productsVariantsOriginIdToShopifyId[y.VariantOriginId]!,
                    mediaId:   y.ImageOriginId)) // (2)!
                .ToList());
    append.RemoveWhere(x => x.Value.Count == 0); // (3)!
    return append;
}
```
1. Las advertencias se emiten antes de filtrar para que queden registradas aunque el elemento sea descartado.
2. Para las asociaciones, `mediaId` es la URL de la imagen (el `OriginId`). El loader necesita la URL porque Shopify puede recibir la asociación vía URL antes de que el ShopifyId esté disponible.
3. Si todas las variantes de un grupo fueron descartadas (sin ShopifyId), el grupo entero se elimina del diccionario.

---

## 7. `BuildDetachMedias`

```csharp title="ImagesTransform.cs"
private Dictionary<string, List<(string VariantId, string MediaId)>> BuildDetachMedias(
    Dictionary<string, string?> productsOriginIdToShopifyId,
    Dictionary<string, string?> productsVariantsOriginIdToShopifyId,
    Dictionary<string, string?> detachMediaOriginIdToShopifyId) // (1)!
{
    // Loguear advertencias para los 3 niveles de resolución...

    var detach = _detachMedias
        .GroupBy(x => x.ProductOriginId)
        .Where(x => productsOriginIdToShopifyId.TryGetValue(x.Key, out var v) && !string.IsNullOrWhiteSpace(v))
        .ToDictionary(
            x => productsOriginIdToShopifyId[x.Key]!,
            x => x
                .Where(y =>
                    productsVariantsOriginIdToShopifyId.TryGetValue(y.VariantOriginId, out var variantShopifyId) &&
                    !string.IsNullOrWhiteSpace(variantShopifyId) &&
                    detachMediaOriginIdToShopifyId.TryGetValue(y.ImageOriginId, out var mediaShopifyId) &&
                    !string.IsNullOrWhiteSpace(mediaShopifyId)) // (2)!
                .Select(y => (
                    VariantId: productsVariantsOriginIdToShopifyId[y.VariantOriginId]!,
                    MediaId:   detachMediaOriginIdToShopifyId[y.ImageOriginId]!))
                .ToList());
    detach.RemoveWhere(x => x.Value.Count == 0);
    return detach;
}
```
1. A diferencia de `BuildAppendMedias`, `BuildDetachMedias` necesita resolver también el `ShopifyId` de la media (no solo la URL). La mutación `productVariantDetachMedia` de Shopify requiere el `mediaId` de Shopify, no la URL.
2. Se aplican los 3 filtros en `Where` antes de proyectar. Solo los elementos que tienen los 3 IDs resueltos llegan al `Select`. Esto garantiza que el loader nunca recibe un `null` en los IDs.
