---
tags:
  - Workflows
  - Procesos
  - Pedidos
  - Shopify
  - ERP
---

# WF-04 — Pedidos: Métodos y funciones

---

## Índice

1. [OrderTransform — clase](#1-ordertransform-clase)
2. [OrderTransform.RunAsync](#2-ordertransformrunasync)
3. [LoadOrders — clase](#3-loadorders-clase)
4. [LoadOrders.RunAsync — bucle de envío](#4-loadordersrunasync-bucle-de-envio)
5. [LoadOrders.GetSyncTag](#5-loadordersgetsynctag)

---

## 1. `OrderTransform` — clase

**Fichero:** `Transformers/OrderTransform.cs`
**Namespace:** `Transformers`
**Hereda de:** `BaseActivity<OrderTransform>`

```csharp
public class OrderTransform : BaseActivity<OrderTransform>
{
    [Input]  public required Input<Box<Order>>      Input  { get; init; }
    private List<Order> _input = null!;

    [Output] public required Output<Box<OrderModel>> Orders { get; set; } = null!;
    ...
}
```

---

## 2. `OrderTransform.RunAsync`

```csharp title="OrderTransform.cs"
protected override Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var config = new MapperConfiguration(cfg => cfg.AddProfile<OrdersMappingProfile>()); // (1)!
    var mapper = config.CreateMapper();

#if DEBUG
    var orderNamesToDebug = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "#SS4185"
    };
    _input = _input
        .Where(order => !string.IsNullOrWhiteSpace(order.Name) &&
                        orderNamesToDebug.Contains(order.Name))
        .ToList(); // (2)!
#endif

    var orders = _input
        .Select(order =>
        {
            var company    = order.GetCompanyDetailsForCustomer()?.Company;
            var customerId = company?.ExternalId; // (3)!
            if (string.IsNullOrWhiteSpace(customerId))
                return null; // (4)!

            var lines  = mapper.Map<OrderLineModel[]>(order.LineItems?.Nodes ?? []);
            var header = mapper.Map<OrderHeaderModel>(order);

            header.CustomerId       = customerId;
            header.LineasDocumento  = lines;

            return new OrderModel(order)
            {
                ShopifyOrder = order,
                Header       = header,
                Lines        = lines
            };
        })
        .Where(order => order is not null)
        .Cast<OrderModel>()
        .ToArray();

    Orders.Set(context, new Box<OrderModel>(orders));
    ...
}
```
1. `OrdersMappingProfile` define los mapeos de `Order` → `OrderHeaderModel` y `LineItem` → `OrderLineModel` con AutoMapper.
2. Bloque `#if DEBUG`: en modo desarrollo, solo procesa los pedidos cuyo `Name` esté en la lista `orderNamesToDebug`. Útil para probar con un pedido específico sin enviar todo el backlog al ERP. Este código no se compila en Release.
3. `ExternalId` es el identificador del cliente en el ERP, almacenado como metafield en la empresa de Shopify. Es el campo que conecta el pedido de Shopify con el cliente del ERP.
4. Si el pedido no tiene empresa asociada (B2C u orden huérfana) o la empresa no tiene `ExternalId`, se devuelve `null` y el pedido se descarta. La cuenta de descartados aparece en el log.

---

## 3. `LoadOrders` — clase

**Fichero:** `Extractors/Models/Orders/LoadOrders.cs`
**Namespace:** `Transformers.Orders`
**Hereda de:** `BaseActivity<LoadOrders>`

> A pesar de su nombre y ubicación en `Extractors/Models/Orders/`, esta clase es un **transformer-loader**: recibe pedidos transformados, los envía al ERP y genera el input para el loader de Shopify.

```csharp
public class LoadOrders : BaseActivity<LoadOrders>
{
    [Input]  public required Input<Box<OrderModel>>   Orders { get; init; }
    private List<OrderModel> _orders = null!;

    [Output] public required Output<OrdersLoaderInput> Output { get; init; }
    ...
}
```

---

## 4. `LoadOrders.RunAsync` — bucle de envío

```csharp title="LoadOrders.cs"
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var provallianceService = context.GetRequiredService<ProvallianceService>();
    var transactionsService = context.GetRequiredService<TransactionsService>();
    var configuration       = context.GetRequiredService<IConfiguration>();
    var syncTag             = GetSyncTag(configuration); // (1)!

    var addTags  = new Dictionary<string, ISet<string>>();
    var synced   = 0;
    var failed   = 0;

    foreach (var order in _orders)
    {
        var currentOrderName = order.ShopifyOrder.Name ?? order.ShopifyOrder.Id ?? order.Header.Id;

        try
        {
            await provallianceService.PostOrder(order.Header); // (2)!

            var shopifyOrderId = order.ShopifyOrder.Id?.Trim();
            if (!string.IsNullOrWhiteSpace(shopifyOrderId))
            {
                if (!addTags.TryGetValue(shopifyOrderId, out var tags))
                {
                    tags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    addTags[shopifyOrderId] = tags;
                }
                tags.Add(syncTag); // (3)!
            }

            synced++;
            await transactionsService.Orders.Create(order.ShopifyOrder, order.Header.Id); // (4)!
        }
        catch (Exception ex)
        {
            failed++;
            await transactionsService.Orders.Create(
                order.ShopifyOrder, order.Header.Id, ex.Message); // (5)!
            _logger.LogError(ex, "Error al cargar pedido {order} en Provalliance.", currentOrderName);
            result.ErrorLogs.Add($"Pedido {currentOrderName} no enviado a Provalliance. Error: {ex.Message}");
        }
    }

    Output.Set(context, new OrdersLoaderInput
    {
        AddTags = addTags.Count > 0 ? addTags : null // (6)!
    });
```
1. `GetSyncTag` lee la tag del filtro para determinar qué tag aplicar a los pedidos procesados. Así el filtro y la tag están siempre sincronizados — si cambias el filtro, cambia la tag y viceversa.
2. `PostOrder` envía el cabecero y las líneas del pedido al middleware de Provalliance vía HTTP. Es una llamada sincrónica desde el punto de vista del código (se espera con `await`).
3. Solo se añade a `addTags` si el envío al ERP fue **exitoso**. Los pedidos fallidos no reciben la tag y reaparecerán en la próxima ejecución.
4. Registra el pedido en `TransactionsDB.Orders` con el Id ERP asignado. Permite auditar qué pedidos se enviaron y cuándo.
5. En caso de error, también se registra en TransactionsDB pero con el mensaje de error. El workflow **no se cancela** — continúa con el siguiente pedido.
6. Si no hubo ningún pedido procesado con éxito, se pasa `null` a `OrdersLoaderInput.AddTags`. El loader externo `OrdersLoader` omite la actualización de Shopify si `AddTags` es nulo.

---

## 5. `LoadOrders.GetSyncTag`

```csharp title="LoadOrders.cs"
private static string GetSyncTag(IConfiguration configuration)
{
    var query = configuration.GetSection("FilterOrders").GetValue<string>("query");
    // (1)!

    if (string.IsNullOrWhiteSpace(query))
        return "Sincronizado"; // (2)!

    const string prefix = "tag_not:";
    var index = query.IndexOf(prefix, StringComparison.OrdinalIgnoreCase);

    if (index < 0)
        return "Sincronizado"; // (3)!

    var tag = query[(index + prefix.Length)..].Trim();
    // (4)!

    return string.IsNullOrWhiteSpace(tag) ? "Sincronizado" : tag;
}
```
1. Lee la query de filtro completa, por ejemplo `"tag_not:Sincronizado"`.
2. Si no está configurado o está vacío, usa `"Sincronizado"` como tag por defecto.
3. Si la query no contiene el prefijo `tag_not:`, no se puede extraer la tag del filtro — usa el valor por defecto.
4. Extrae el texto después de `tag_not:`. Para `"tag_not:Sincronizado"`, el resultado es `"Sincronizado"`. Esta lógica garantiza que el extractor y el loader siempre usen la misma tag sin repetir la configuración.

### Tabla de ejemplos

| `FilterOrders:query` | Tag aplicada |
|---|---|
| `"tag_not:Sincronizado"` | `"Sincronizado"` |
| `"tag_not:EnviadoERP"` | `"EnviadoERP"` |
| `""` (vacío) | `"Sincronizado"` |
| `"financial_status:paid"` | `"Sincronizado"` (no tiene prefijo `tag_not:`) |
