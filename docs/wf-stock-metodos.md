---
tags:
  - Workflows
  - Procesos
  - Stock
  - ERP
  - Shopify
---

# WF-02 — Stock: Métodos y funciones

---

## Índice

1. [StockExtract — clase](#1-stockextract-clase)
2. [StockExtract.RunAsync](#2-stockextractrunasync)
3. [StockTransform — clase](#3-stocktransform-clase)
4. [StockTransform.InitInputs](#4-stocktransforminitinputs)
5. [StockTransform.ShouldRunAsync](#5-stocktransformshouldrunasync)
6. [StockTransform.RunAsync — resolución de IDs](#6-stocktransformrunasync-resolucion-de-ids)
7. [StockTransform.RunAsync — construcción del output](#7-stocktransformrunasync-construccion-del-output)

---

## 1. `StockExtract` — clase

**Fichero:** `Extractors/StockExtract.cs`
**Namespace:** `Extractors`
**Hereda de:** `BaseActivity<StockExtract>`

```csharp
public class StockExtract : BaseActivity<StockExtract>
{
    [Output] public required Output<Box<Stock>> Output { get; init; }
    ...
}
```

Un único output: `Box<Stock>`. Sin inputs del workflow — toda su configuración viene del servicio inyectado `ProvallianceService`.

---

## 2. `StockExtract.RunAsync`

```csharp title="StockExtract.cs"
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    _logger.LogInformation("Recuperando el stock del middleware");

    var provallianceService = context.GetRequiredService<ProvallianceService>(); // (1)!

    var response = await FuncUtils.WithCachedRun( // (2)!
        () => provallianceService.GetStock(),
        "tmp/debug/provalliance/middleware", "stock", _logger);

    Output.Set(context, response); // (3)!

    return new ActivityResult
    {
        InformationLogs =
        [
            $"Recuperados el stock de {response.Count} variantes del middleware."
        ]
    };
}
```
1. `ProvallianceService` se obtiene del contenedor de dependencias del workflow. Encapsula la autenticación OAuth2 con el middleware de Provalliance.
2. `FuncUtils.WithCachedRun` guarda la respuesta en `tmp/debug/provalliance/middleware/stock.json` durante el desarrollo. En producción, el caché está deshabilitado y siempre llama al ERP en tiempo real.
3. `response` ya es `Box<Stock>` — el método `GetStock()` devuelve el tipo correcto directamente, sin transformación adicional aquí.

---

## 3. `StockTransform` — clase

**Fichero:** `Transformers/StockTransform.cs`
**Namespace:** `Transformers`
**Hereda de:** `BaseActivity<StockTransform>`

```csharp
public class StockTransform : BaseActivity<StockTransform>
{
    [Input]  public required Input<Box<Stock>>      Input  { get; init; }
    private List<Stock> _input = null!;

    [Output] public required Output<SyncStockInput> Output { get; set; }
    ...
}
```

---

## 4. `StockTransform.InitInputs`

```csharp title="StockTransform.cs"
protected override void InitInputs(ActivityExecutionContext context)
{
    _input = Input.Get(context).Property.ToList(); // (1)!
}
```
1. `Box<Stock>.Property` es el `ICollection<Stock>` interno del wrapper. Se materializa como `List<Stock>` para poder iterarla múltiples veces sin recalcularla.

---

## 5. `StockTransform.ShouldRunAsync`

```csharp title="StockTransform.cs"
protected override bool ShouldRunAsync() => _input is { Count: >0 };
```

Si el ERP no devolvió ningún registro de stock, se omite toda la lógica de transformación y no se produce ninguna actualización en Shopify.

---

## 6. `StockTransform.RunAsync` — resolución de IDs

```csharp title="StockTransform.cs"
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var config = context.GetRequiredService<IConfiguration>();
    var locationId = config["ShopifyCredentials:LocationId"].ShouldNotBeNull(); // (1)!

    var transactionsService = context.GetRequiredService<TransactionsService>();

    var products = await transactionsService.Products.Get(); // (2)!
    var helperDict = products
        .SelectMany(p => p.Variants.Select(v => new
        {
            VariantSku       = v.Referencia,      // EAN de la variante
            VariantShopifyId = v.DestinoId,
            ProductShopifyId = p.DestinoId
        }))
        .Where(x => !string.IsNullOrWhiteSpace(x.VariantSku))
        .GroupBy(x => x.VariantSku!)
        .ToDictionary(x => x.Key, x => x.ToList()); // (3)!
```
1. `ShouldNotBeNull()` es una extensión de `SharedUtils` que lanza si el valor es nulo, con un mensaje de error claro. Garantiza que el `LocationId` esté configurado antes de continuar.
2. Lee todos los productos y variantes de `TransactionsDB`. Este diccionario es la tabla de correspondencias `EAN → ShopifyIds`.
3. Se agrupa por EAN porque un mismo EAN puede estar en múltiples variantes (caso raro pero posible si hay duplicados en TransactionsDB). El stock se aplica a todas las variantes que compartan ese EAN.

---

## 7. `StockTransform.RunAsync` — construcción del output

```csharp title="StockTransform.cs"
    Dictionary<string, List<VariantStockUpdate>> result = new();
    
    foreach (var inputStock in _input) // (1)!
    {
        if (!helperDict.TryGetValue(inputStock.Ean, out var variants))
        {
            _logger.LogError("No se encontró el Id de Shopify para el EAN {ean}, " +
                "se descartará su stock de {num} unidades.", inputStock.Ean, inputStock.Quantity);
            continue;
        }

        foreach (var variant in variants)
        {
            AddStockUpdate(variant.ProductShopifyId, variant.VariantShopifyId, inputStock.Quantity);
        }
    }

    var inputSkus = _input.Select(y => y.Ean).ToHashSet();
    var variantsWithMissingStock = helperDict  // (2)!
        .Where(x => !inputSkus.Contains(x.Key))
        .SelectMany(x => x.Value)
        .ToList();
    foreach (var variant in variantsWithMissingStock)
    {
        AddStockUpdate(variant.ProductShopifyId, variant.VariantShopifyId, 0); // (3)!
    }

    Output.Set(context, new SyncStockInput
    {
        Variants = result.ToDictionary(x => x.Key, x => x.Value.ToArray())
    });
```
1. Primer bucle: procesa las variantes que sí vienen del ERP. Si un EAN no tiene ShopifyId en TransactionsDB (nunca se sincronizó o fue borrado del sistema), se descarta con error.
2. Segundo bloque: detecta las variantes que **están en TransactionsDB** (ya existen en Shopify) pero **no llegaron en la respuesta del ERP**. Estas se marcan con stock `0`.
3. El stock `0` evita discrepancias entre Shopify y el ERP: si el ERP no informa de una variante, se asume que no tiene stock disponible.

```csharp
    void AddStockUpdate(string productShopifyId, string variantShopifyId, int stock) // (4)!
    {
        if (!result.TryGetValue(productShopifyId, out var productStockEntry))
        {
            result[productShopifyId] = productStockEntry = [];
        }
        productStockEntry.Add(new VariantStockUpdate
        {
            IdShopifyVariant = variantShopifyId,
            LocationId       = locationId,
            Stock            = stock
        });
    }
```
4. Función local que agrupa las actualizaciones por `productShopifyId`. `SyncStock` necesita agrupar por producto para llamar a `inventorySetQuantities` una vez por producto en lugar de una vez por variante.
