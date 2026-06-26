---
tags:
  - Workflows
  - Procesos
  - Productos
  - PIM
  - Shopify
---

# WF-01 — Productos: Métodos y funciones

---

## Índice

1. [ProductsWithImagesExtract — clase](#1-productswithimagesextract-clase)
2. [ProductsWithImagesExtract.RunAsync](#2-productswithimagesextractrunasync)
3. [ProductsRebuildDecision — clase](#3-productsrebuilddecision-clase)
4. [ProductsRebuildDecision.RunAsync — clasificación](#4-productsrebuilddecisionrunasync-clasificacion)
5. [ProductsRebuildDecision.RunAsync — post-procesamiento](#5-productsrebuilddecisionrunasync-post-procesamiento)
6. [ProductsCreateTransform — ShouldRunAsync](#6-productscreatetransform-shouldrunasync)
7. [ProductsUpdateTransform — archivado](#7-productsupdatetransform-archivado)
8. [ProductsDeleteTransform — RunAsync](#8-productsdeletetransform-runasync)

---

## 1. `ProductsWithImagesExtract` — clase

**Fichero:** `Extractors/ProductsWithImagesExtract.cs`
**Namespace:** `Extractors`
**Hereda de:** `BaseActivity<ProductsWithImagesExtract>`

```csharp
public class ProductsWithImagesExtract : BaseActivity<ProductsWithImagesExtract>
{
    [Output] public required Output<Box<IProduct>>      ProductsOutput       { get; init; }
    [Output] public required Output<Box<IProductImage>> ProductsImagesOutput { get; init; }
    ...
}
```

Dos outputs. En este workflow, `ProductsOutput` se conecta a la variable `productos`. En el workflow de **Imágenes Shopify**, `ProductsImagesOutput` es el que se conecta.

---

## 2. `ProductsWithImagesExtract.RunAsync`

```csharp title="ProductsWithImagesExtract.cs"
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var salesLayerService = context
        .GetRequiredService<SalesLayerClientService>()
        .GetService("CanalSalida"); // (1)!

    var response = await FuncUtils.WithCachedRun(
        () => salesLayerService.GetInfoAsync(),
        "tmp/debug/provalliance/saleslayer", "salonspace", _logger);

    if (response.HasError)
        throw new Exception($"Error al recuperar los productos de SalesLayer: {response.ErrorMessage}");

    var data = response.Data.ToObject<SalonSpaceResponse>()!;

    // (2)! Normalizar: Visible + Obsoleto = Invisible
    data.Products
        .Where(x => x is { Obsoleto: true, Estatus: Estatus.Visible })
        .ForEach(x => x.Estatus = Estatus.Invisible);

    List<Product> products = [];

    // (3)! Productos simples (sin CodigoAgrupacion)
    foreach (var productoSimple in data.Products.Where(x => string.IsNullOrWhiteSpace(x.CodigoAgrupacion)))
    {
        try { products.Add(new Product(productoSimple.Sku, [productoSimple])); }
        catch (Exception e) { _logger.LogError(e, "Error al generar el producto simple con Id {id}.", productoSimple.Sku); }
    }

    // (4)! Productos con variantes (agrupados por CodigoAgrupacion)
    foreach (var group in data.Products.Where(x => !string.IsNullOrWhiteSpace(x.CodigoAgrupacion)).GroupBy(x => x.CodigoAgrupacion))
    {
        try { products.Add(new Product(group.Key!, group.Select(v => v).ToArray())); }
        catch (Exception e) { _logger.LogError(e, "Error al generar el producto con variantes para la agrupación {id}.", group.Key); }
    }

    // (5)! Eliminar duplicados
    var productsWithDuplicatedId = products.GroupBy(x => x.OriginId).Where(x => x.Count() > 1).SelectMany(x => x.Skip(1)).ToList();
    products.RemoveAll(x => productsWithDuplicatedId.Contains(x));
    productsWithDuplicatedId.GroupBy(x => x.OriginId)
        .ForEach(x => _logger.LogError("El Id de origen {ref} está duplicado en {num} productos...", x.Key, x.Count() + 1));

    var variantsWithDuplicatedId = products.Select(x => (x.OriginId, DuplicatedVariants: x.RemoveDuplicatedVariants())).ToList();
    variantsWithDuplicatedId.Where(x => x.DuplicatedVariants.Count > 0)
        .ForEach(x => _logger.LogError("El producto con Id {ref} tenía {num} variantes duplicadas...", x.OriginId, x.DuplicatedVariants.Count + 1));

    ProductsOutput.Set(context, new Box<IProduct>(products.OfType<IProduct>().ToList()));
    
    var productsImages = products
        .SelectMany(x => x.GetParentImages().Union(x.GetVariantsImages()).DistinctBy(i => i.ImageOriginId))
        .ToList(); // (6)!
    ProductsImagesOutput.Set(context, new Box<IProductImage>(productsImages));
    ...
}
```
1. `"CanalSalida"` es el nombre del canal PIM configurado en `PIM:CanalSalida`. `SalesLayerClientService` es un servicio con soporte multi-canal — el nombre selecciona el `ChannelId` y `APIKey` correctos.
2. Un producto `Visible + Obsoleto` es una contradicción semántica del PIM. Se normaliza a `Invisible` para que el workflow lo trate como inactivo en Shopify.
3. Productos **simples**: sin `CodigoAgrupacion`, el SKU es el identificador del producto. Se crea un `Product` con una sola variante.
4. Productos **con variantes**: todos los ítems del PIM con el mismo `CodigoAgrupacion` forman un producto padre. El `OriginId` del producto es el `CodigoAgrupacion`.
5. El PIM puede devolver SKUs duplicados en casos de error de configuración. Se elimina el segundo y sucesivos duplicados y se registra el error para diagnóstico. Igual con variantes duplicadas dentro de un producto.
6. Las imágenes se extraen de los productos ya construidos: `GetParentImages()` devuelve las imágenes del producto padre, `GetVariantsImages()` las de cada variante. `DistinctBy(ImageOriginId)` evita duplicados si la misma imagen aparece en padre y variante.

---

## 3. `ProductsRebuildDecision` — clase

**Fichero:** `Decisions/ProductsRebuildDecision.cs`
**Namespace:** `Decisions`
**Hereda de:** `BaseActivity<ProductsRebuildDecision>`

```csharp
public class ProductsRebuildDecision : BaseActivity<ProductsRebuildDecision>
{
    private const int MaxNumVariants = 2048;

    [Input]  public required Input<Box<IProduct>>    ProductosInput   { get; init; }
    [Output] public required Output<Box<IProduct>>   ProductosCrear   { get; init; }
    [Output] public required Output<Box<IProduct>>   ProductosActualizar { get; init; }
    [Output] public required Output<Box<OrigenId>>   ProductosArchivar { get; init; }
    [Output] public required Output<Box<OrigenId>>   ProductosBorrar   { get; init; }
    [Output] public required Output<Box<IVariant>>   VariantesCrear    { get; init; }
    [Output] public required Output<Box<IVariant>>   VariantesActualizar { get; init; }
    [Output] public required Output<Box<OrigenId>>   VariantesBorrar   { get; init; }
    [Output] public required Output<Box<IProduct>>   RebuildProductOptions { get; init; }
    ...
}
```

---

## 4. `ProductsRebuildDecision.RunAsync` — clasificación

```csharp title="ProductsRebuildDecision.cs"
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var transactionsService = context.GetRequiredService<TransactionsService>();

    // (1)! Descartar productos que superan el límite de variantes de Shopify
    var exceededMaxNumVariants = _productos.RemoveAllAndGetRemoved(p => p.GetVariants().Count > MaxNumVariants);

    var dbProducts           = await transactionsService.Products.Get();
    var dbProductsByOriginId = dbProducts.ToDictionary(x => x.OrigenId);
    var dbProductOriginIds   = dbProductsByOriginId.Keys.ToHashSet();
    var dbVariantOriginIds   = dbProducts.SelectMany(x => x.Variants.Select(v => v.OrigenId)).ToHashSet();

    var currentProductOriginIds = _productos.Select(x => x.OriginId).ToHashSet();
    var currentVariantOriginIds = _productos.SelectMany(x => x.GetVariants().Select(v => v.OriginId)).ToHashSet();

    foreach (var product in _productos)
    {
        dbProductsByOriginId.TryGetValue(product.OriginId, out var dbProduct);

        if (product.Status == EntityStatus.Deleted)
        {
            if (dbProduct is not null) productosArchivar.Add(product.OriginId); // (2)!
            continue;
        }
        if (product.Status == EntityStatus.Inactive && dbProduct is null)
        {
            continue; // (3)!
        }
        if (dbProduct is null)
        {
            productosCrear.Add(product); // (4)!
            continue;
        }

        // (5)! Verificar si cambiaron las opciones del producto
        var productOptionNames   = product.GetSortedOptions().Keys.ToHashSet();
        var dbProductOptionNames = dbProduct.Options.Select(x => x.Referencia).ToHashSet();
        if (!productOptionNames.SetEquals(dbProductOptionNames))
        {
            rebuildProductOptions.Add(product);
            continue;
        }

        productosActualizar.Add(product); // (6)!
        // ... clasificar variantes del producto
    }

    // (7)! Productos/variantes en DB pero ausentes en el PIM → a archivar/borrar
    productosArchivar.UnionWith(dbProductOriginIds.Except(currentProductOriginIds));
    variantesBorrar.UnionWith(dbVariantOriginIds.Except(currentVariantOriginIds));
```
1. Shopify tiene un límite de 2048 variantes por producto. Los productos que lo superan se descartan antes de cualquier procesamiento para evitar errores en los loaders.
2. Un producto marcado como `Deleted` en el PIM se archiva (no se borra) si ya existe en Shopify. Si no existe, simplemente se ignora.
3. Un producto `Inactive` que no existe en Shopify se ignora — no tiene sentido crear algo que ya está inactivo.
4. El producto no existe en TransactionsDB → es nuevo → se añade a `productosCrear`.
5. Las **opciones** son los atributos que definen las variantes de un producto (ej: `["Color", "Talla"]`). Si cambian (se añade una opción o se elimina), Shopify requiere reconstruir todas las variantes del producto. Se pone en `rebuildProductOptions` en lugar de `productosActualizar`.
6. El producto existe y sus opciones no cambiaron → actualización normal. Las variantes se clasifican individualmente en el bucle interno (crear/actualizar/borrar).
7. Productos y variantes que están en TransactionsDB (ya existen en Shopify) pero no aparecen en la respuesta del PIM se añaden a los conjuntos de archivado/borrado. Esta es la lógica de **full-sync**: el PIM es la fuente de verdad completa.

---

## 5. `ProductsRebuildDecision.RunAsync` — post-procesamiento

```csharp title="ProductsRebuildDecision.cs"
    foreach (var dbProduct in dbProducts)
    {
        var productVariantOriginIds = dbProduct.Variants.Select(x => x.OrigenId).Distinct().ToHashSet();
        if (productVariantOriginIds.Count == 0) continue;

        var productOriginId      = dbProduct.OrigenId;
        var productAlreadyDeleting = productosArchivar.Contains(productOriginId);

        if (!productAlreadyDeleting && productVariantOriginIds.All(variantesBorrar.Contains))
        {
            // (1)! Todas las variantes van a borrarse → promover el producto
            if (productVariantOriginIds is { Count: 1 } && productVariantOriginIds.First().EndsWith("-$"))
                productosBorrar.Add(productOriginId);  // Borrado definitivo
            else
                productosArchivar.Add(productOriginId); // Archivado

            productosActualizar.RemoveWhere(x => x.OriginId == productOriginId);
            variantesCrear.RemoveWhere(x => x.ProductOriginId == productOriginId);
            productAlreadyDeleting = true;
        }

        if (productAlreadyDeleting && variantesBorrar.Overlaps(productVariantOriginIds))
        {
            variantesBorrar.ExceptWith(productVariantOriginIds); // (2)!
        }
    }
```
1. Si un producto tiene **todas** sus variantes marcadas para borrar, es más eficiente archivar/borrar el producto directamente. El caso especial `-$` indica un producto placeholder creado por el loader cuando falló la creación de variantes — ese sí se borra definitivamente.
2. Si el producto ya se va a archivar o borrar, no tiene sentido borrar sus variantes individualmente — Shopify las elimina con el producto. Se suprimen las eliminaciones de variantes individuales para evitar llamadas API redundantes.

---

## 6. `ProductsCreateTransform` — ShouldRunAsync

```csharp title="ProductsCreateTransform.cs"
protected override bool ShouldRunAsync() =>
    _productosCrearInput is { Count: > 0 } || _variantesCrearInput is { Count: > 0 };
```

Se ejecuta si hay productos **o** variantes (de productos existentes) a crear. Las variantes de productos existentes se crean aquí cuando el producto ya existe en Shopify pero se añadió una nueva variante.

---

## 7. `ProductsUpdateTransform` — archivado

La parte más interesante del transformer de actualización es la lógica de archivado:

```csharp title="ProductsUpdateTransform.cs"
var productShopifyIdsToArchive = _productosArchivarInput
    .Select(originId => productsShopifyIds.TryGetValue(originId, out var shopifyId) ? shopifyId : null)
    .Where(shopifyId => !string.IsNullOrWhiteSpace(shopifyId))
    .Select(shopifyId => shopifyId!)
    .ToHashSet();

var shopifyProducts = await shopifySdk.Products.RetrieveStatuses(productShopifyIdsToArchive); // (1)!

foreach (var originId in _productosArchivarInput)
{
    if (shopifyProduct.Status is ProductStatus.ARCHIVED) continue; // (2)!

    var archivedProduct = new OriginInput<ProductUpdateInput>
    {
        OriginId = originId,
        Input = new ProductUpdateInput
        {
            Id     = shopifyId,
            Status = ProductStatus.ARCHIVED,
            Handle = $"{shopifyProduct.Handle}-{DateTime.Today:yyMMdd}{Random.Shared.Next(10000, 99999)}" // (3)!
        }
    };
    UpsertProductToUpdate(archivedProduct);
}
```
1. Se consulta el estado actual de los productos en Shopify antes de archivarlos. Necesario para: (a) verificar si ya están archivados, y (b) obtener el `Handle` actual para modificarlo.
2. Si el producto ya está archivado, se salta. Evita actualizaciones redundantes.
3. El `Handle` se modifica añadiendo fecha y número aleatorio. Shopify requiere handles únicos — si el producto se vuelve a crear con el mismo Handle (ej. el artículo vuelve al PIM), el Handle anterior archivado no puede bloquear la creación.

---

## 8. `ProductsDeleteTransform` — RunAsync

```csharp title="ProductsDeleteTransform.cs"
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var transactionsService = context.GetRequiredService<TransactionsService>();

    // (1)! Resolver ShopifyIds de productos a borrar
    var destinoProductsIdsDb = await transactionsService.Products.FindShopifyIds(_productosEliminarInput.ToHashSet());
    var productsToDelete = _productosEliminarInput
        .Select(x => destinoProductsIdsDb.GetValueOrDefault(x))
        .DiscardNulls()
        .ToList();

    // (2)! Resolver ShopifyIds de variantes a borrar y encontrar sus productos padre
    var destinoVariantIdsDb = await transactionsService.Products.Variants.FindShopifyIds(_variantesEliminarInput.ToHashSet());
    var destinoVariantIdsToDelete = destinoVariantIdsDb
        .Where(x => !string.IsNullOrWhiteSpace(x.Value))
        .Select(x => x.Value!)
        .ToHashSet();

    var destinationProductIdsByVariantId = destinoVariantIdsToDelete.Count > 0
        ? await transactionsService.Products.Variants.FindProductsDestinationIdFromDestinationsIds(destinoVariantIdsToDelete)
        : new Dictionary<string, string>();

    // Construir diccionario: productShopifyId → [variantShopifyId, ...]
    var variantsDictionaryToDelete = new Dictionary<DestinoId, List<DestinoId>>();
    ...
```
1. `DiscardNulls()` elimina los productos cuyos OriginIds no tienen entrada en TransactionsDB. Si el producto nunca llegó a crearse en Shopify (por ejemplo, falló en un ciclo anterior), no hay nada que borrar.
2. Para borrar variantes individuales, Shopify necesita tanto el ShopifyId de la variante como el del producto padre. Se hace en dos consultas: primero OriginId → variantShopifyId, luego variantShopifyId → productShopifyId.
