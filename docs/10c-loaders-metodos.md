---
tags:
  - Loaders
  - Mirror
  - Shopify
---

# 10c — Loaders y Mirror: métodos y funciones

> **¿Buscas la descripción general de cada loader?**
> → [`10-loaders.md`](10-loaders.md) — qué hace cada loader y su secuencia de sub-operaciones.
> → [`10b-loaders-detalle.md`](10b-loaders-detalle.md) — campos de los modelos de input y detalle de sub-operaciones con referencias cruzadas.

---

## 1. ProductsWithVariantsCreate — CreateProductsAndVariants

**Fichero:** `Loaders/Shopify/Products/ProductsWithVariantsCreate.cs`

Orquesta los cinco pasos de la creación de productos con variantes. El orden es obligatorio: si falla el paso 1, los pasos 3 y 4 no tienen datos válidos.

```csharp
async Task<ActivityResult> CreateProductsAndVariants()
{
    // 1. Crear los productos en bulk
    var productsToCreate = _input.Products!.Select(x => x.product).ToList();
    var (productsResult, createdProducts) = await CreateProducts(productsToCreate);

    // 2. Excluirlos de todos los mercados (si está configurado)
    if (_input.ExcludeNewProductsFromMarkets)
    {
        var allMarkets = await _shopifySdk.Markets.GetAll() ?? new List<Market>();
        var productsToExclude = createdProducts
            .Where(x => !string.IsNullOrWhiteSpace(x?.Product?.Id))
            .Select(x => x!.Product!.Id!)
            .Distinct()
            .ToDictionary(productId => productId,
                          _ => allMarkets.Select(x => x.Id!).ToArray());
        productsResult += await PriceListsB2C.ExcludeProductsFromMarkets(
            _shopifySdk, _transactionsService, _logger, productsToExclude);
    }

    // 3. Crear las variantes (solo de los productos que se crearon correctamente)
    var shopifyIdPerProductOrigin =
        await _transactionsService.Products.FindShopifyIds(
            _input.Products!.Select(x => x.product.OriginId).ToHashSet());
    var variantsToCreate = _input.Products!
        .Select(x => (shopifyId: shopifyIdPerProductOrigin[x.product.OriginId], x.variants))
        .Where(x => x.shopifyId != null)
        .GroupBy(x => x.shopifyId)
        .ToDictionary(x => x.Key!, x => x.SelectMany(x => x.variants).Distinct().ToArray());
    if (variantsToCreate.Count > 0)
        productsResult += await CreateVariants(variantsToCreate);

    // 4. Eliminar las variantes por defecto creadas por Shopify (las marcadas con "$")
    _ = await DeleteDefaultVariants(createdProducts);

    // 5. Reordenar las opciones al orden del PIM
    var productsWithOptions = await _transactionsService.Products.Options.Retrieve(
        productsToCreate.Select(x => x.OriginId).ToHashSet());
    // [lógica de conversión OriginId → ShopifyId para cada opción]
    productsResult += await ProductsWithVariantsUpdate.ReorderOptions(
        _logger, _shopifySdk, _transactionsService, options);

    return productsResult;
}
```

**El truco del `$` (paso 1)**

`CreateProducts` inserta artificialmente `"$"` como primer valor en cada opción antes de llamar a `BulkCreate`:

```csharp
products.ForEach(x =>
    x.Input.ProductOptions.ForEach(x =>
        x.Values.Insert(0, new OptionValueCreateInput { Name = "$" })));
```

Shopify crea automáticamente una variante por defecto usando los **primeros valores** de cada opción. Al poner `$` primero, esa variante ficticia recibe `$` en todos sus campos y es fácilmente identificable para borrarla en el paso 4.

Los productos sin opciones reciben una opción por defecto `"Title"/"Default Title"` antes de la inserción del `$`, para cumplir el esquema mínimo de Shopify.

**Exclusión de mercados (paso 2)**

Solo se ejecuta si `ExcludeNewProductsFromMarkets = true` (valor por defecto `true`). La justificación está en el código fuente:

> *Shopify incluye el producto en todos los mercados sin sobrescribir el precio, así que lo más sencillo es excluirlo de todos en este punto y delegar en el flujo de precios la inclusión del producto en los mercados correspondientes. De esta manera, garantizamos que un producto solo aparezca en el mercado cuando tenga el precio correcto cargado.*

**Por qué el paso 3 consulta la BD en lugar de usar el resultado del paso 1**

El código llama a `_transactionsService.Products.FindShopifyIds()` en lugar de usar directamente los IDs devueltos por `BulkCreate`. Esto descarta las variantes de los productos que fallaron en el paso 1 — si un producto no se creó correctamente, no tendrá registro en la BD y su `ShopifyId` será `null`.

Si alguna variante llega sin SKU, el método lanza una excepción de desarrollo antes de llamar a la API:

```csharp
if (variantsWithProductsIds.Values.SelectMany(x => x)
    .Any(x => x.Input.InventoryItem?.Sku is null))
{
    throw new ShopifyDeveloperErrorException(
        "Se ha intentado cargar una variante SIN SKU. Error de desarrollo. Abortando.", null);
}
```

**Variantes por defecto como señal de estado (paso 4)**

El borrado de las variantes `$` también funciona como **indicador de integridad**: si tras el workflow un producto todavía tiene una variante con SKU `$`, significa que su carga no completó correctamente y puede usarse como señal para detectar cargas parciales.

**Reordenación final (paso 5)**

Llama al método estático `ProductsWithVariantsUpdate.ReorderOptions()` para garantizar que el orden de las opciones en Shopify coincide con el orden del PIM. Shopify puede reordenar opciones internamente tras la creación masiva.

---

## 2. ProductsWithVariantsUpdate — RebuildProductOptions

**Fichero:** `Loaders/Shopify/Products/ProductsWithVariantsUpdate.cs`

El proceso más complejo del sistema. Se ejecuta cuando las opciones de un producto han cambiado estructuralmente (añadir o eliminar una dimensión de variante, como pasar de "Color+Talla" a solo "Color"). Shopify no permite reemplazar opciones directamente.

La secuencia completa es: `Prechecks` → `StartMigrations` → por producto: [`ClearVariants`](#clearvariants) → [`MigrateOptions`](#migrateoptions) → `CreateVariants` → [`EndMigration`](#endmigration).

**Pre-checks antes de migrar**

Antes de entrar al bucle por producto, el método descarta los productos que no pueden procesarse:

```csharp
void Prechecks()
{
    // 1. Descartar productos que superan el máximo de 3 opciones de Shopify
    var maxOptionsReached = productsOptionsToCreate
        .Where(x => x.Value
            .SelectMany(v => v.Input.OptionValues.Select(v => v.OptionName))
            .Distinct().Count() > maxProductOptions)  // maxProductOptions = 3
        .ToList();
    maxOptionsReached.ForEach(x => _logger.LogError(
        "No se pueden reconstruir las opciones del producto {id} porque sus nuevas opciones " +
        "superan el máximo permitido.", x.Key));
    productsOptionsToCreate.RemoveWhere(x =>
        maxOptionsReached.Select(x => x.Key).Contains(x.Key));

    // 2. Descartar productos con variantes que tienen combinaciones de opciones duplicadas
    var duplicatedOptions = productsOptionsToCreate
        .Select(productVariants => new
        {
            productVariants.Key,
            Duplicates = productVariants.Value
                .GroupBy(variant => GetOptionCombinationKey(variant.Input.OptionValues))
                .Where(group => group.Count() > 1)
                .ToList()
        })
        .Where(x => x.Duplicates.Count > 0)
        .ToList();
    duplicatedOptions.ForEach(x => _logger.LogError(
        "No se pueden reconstruir las opciones del producto {id} porque existen variantes nuevas " +
        "con combinaciones de valores duplicados: {duplicates}.", x.Key, ...));
    productsOptionsToCreate.RemoveWhere(x =>
        duplicatedOptions.Select(x => x.Key).Contains(x.Key));
}
```

**StartMigrations:** pone en borrador todos los productos a migrar para que los cambios sean invisibles al cliente durante la operación.

**Bucle por producto:**

```csharp
foreach (var (shopifyId, newVariants) in productsOptionsToCreate)
{
    var dbProduct = dbProducts.SingleOrDefault(x => x.DestinoId == shopifyId);
    if (dbProduct is null) { _logger.LogError(...); continue; }

    var centinelaId = await ClearVariants(dbProduct);

    var newOptions = newVariants
        .SelectMany(x => x.Input.OptionValues)
        .GroupBy(x => x.OptionName!)
        .ToDictionary(x => x.Key, x => x.Select(x => x.Name!).Distinct().ToArray());

    await MigrateOptions(dbProduct, newOptions);

    var createdVariants = await CreateVariants(dbProduct, newVariants);

    await EndMigration(dbProduct, centinelaId, optionsToReorder);
}
```

### ClearVariants

Prepara el producto para la migración dejándolo con solo la variante centinela:

```csharp
async Task<ShopifyId> ClearVariants(ElsaShared.Data.Shopify.Product dbProduct)
{
    // 1. Añadir "$" como valor a TODAS las opciones actuales del producto
    foreach (var productOption in dbProduct.Options)
    {
        await _shopifySdk.Products.Options.Update(
            dbProduct.DestinoId,
            new OptionUpdateInput { Id = productOption.DestinoId },
            optionValuesToAdd: [new OptionValueCreateInput { Name = "$" }],
            optionValuesToUpdate: null,
            optionValuesToDelete: null);
    }

    // 2. Crear la variante centinela ($ en todas las opciones, SKU = "$")
    var resultadoCreacionCentinela = await _shopifySdk.Products.Variants.BulkCreate(
        new Dictionary<string, ProductVariantsBulkInput[]>
        {
            {
                dbProduct.DestinoId,
                [new ProductVariantsBulkInput
                {
                    OptionValues = dbProduct.Options
                        .Select(x => new VariantOptionValueInput
                            { OptionId = x.DestinoId, Name = "$" })
                        .ToList(),
                    InventoryItem = new InventoryItemInput { Sku = "$" }
                }]
            }
        });

    string? centinelaId = null;

    // Recuperación si la centinela ya existía (ejecución anterior fallida a mitad)
    if (resultadoCreacionCentinela.First()?.UserErrors.First()?.Code is
        ProductVariantsBulkCreateUserErrorCode.VARIANT_ALREADY_EXISTS or
        ProductVariantsBulkCreateUserErrorCode.VARIANT_ALREADY_EXISTS_CHANGE_OPTION_VALUE)
    {
        var product = (await _shopifySdk.Products.Retrieve(
            $"id:{dbProduct.DestinoId.Split('/').Last()}")).FirstOrDefault();
        centinelaId = product?.Variants.Nodes
            .FirstOrDefault(x => x.SelectedOptions.All(x => x.Value == "$"))?.Id;
    }
    else
    {
        centinelaId = resultadoCreacionCentinela.Single()!
            .ProductVariants.FirstOrDefault(x => x.Sku == "$")?.Id;
    }

    if (centinelaId is null)
        throw new Exception("Ha ocurrido un error al crear la variante centinela...");

    // 3. Borrar todas las variantes reales del producto
    var variantsToDelete = new Dictionary<string, string[]>
    {
        { dbProduct.DestinoId, dbProduct.Variants.Select(x => x.DestinoId).ToArray() }
    };
    var resultadoEliminacion = await _shopifySdk.Products.Variants.BulkDelete(variantsToDelete);
    _ = await _transactionsService.Products.Variants.Delete(variantsToDelete, resultadoEliminacion);

    return centinelaId;
}
```

**Por qué la centinela es imprescindible:** Shopify exige que un producto tenga al menos una variante en todo momento. Durante la migración se borran todas las variantes reales, por lo que la centinela ocupa ese lugar temporalmente.

**Recuperación ante fallos previos:** si una ejecución anterior del workflow falló a mitad de la migración, la centinela puede ya existir en Shopify. El código lo detecta por el `UserError.Code` `VARIANT_ALREADY_EXISTS` y la recupera de Shopify en lugar de intentar crearla de nuevo, permitiendo reanudar la migración desde ese punto.

### MigrateOptions

Migra las opciones respetando el límite máximo de 3 por producto mediante un bucle iterativo:

```csharp
async Task MigrateOptions(ElsaShared.Data.Shopify.Product dbProduct,
                          Dictionary<string, string[]> newOptions)
{
    var currentProductOptions = dbProduct.Options.Select(x => x.Referencia!).ToList();
    var productOptionsToDelete = dbProduct.Options
        .Where(x => !newOptions.ContainsKey(x.Referencia!)).ToList();
    var productOptionsToCreate = newOptions
        .Where(x => !currentProductOptions.Contains(x.Key)).ToList();

    for (int i = 0; productOptionsToDelete.Count > 0 || productOptionsToCreate.Count > 0; i++)
    {
        var productOptionsLimitReached = currentProductOptions.Count == maxProductOptions; // 3

        // Sin hueco y hay que crear → eliminar una para hacer espacio
        if (productOptionsLimitReached && productOptionsToCreate.Count > 0)
        {
            await DeleteProductOption(productOptionsToDelete.First()!);
            continue;
        }

        // Hay hueco y hay que crear → crear
        if (!productOptionsLimitReached && productOptionsToCreate.Count > 0)
        {
            await CreateProductOption(productOptionsToCreate.First());
            continue;
        }

        // No hay pendientes de crear, pero sí de eliminar
        if (productOptionsToCreate.Count == 0 && productOptionsToDelete.Count > 0)
        {
            if (currentProductOptions.Count == 1)
            {
                _logger.LogWarning("No se va a eliminar la última opción del producto...");
                break;
            }
            await DeleteProductOption(productOptionsToDelete.First()!);
            continue;
        }

        throw new NotImplementedException("El bucle nunca debería llegar aquí.");
    }
}
```

Cada iteración toma una decisión con tres ramas:
1. **Límite alcanzado + necesito crear** → eliminar una de las pendientes para hacer hueco
2. **Hay hueco + necesito crear** → crear
3. **No hay pendientes de crear + hay pendientes de eliminar** → eliminar

Las opciones nuevas se crean con `$` como primer valor para que la variante centinela siga siendo válida mientras dura la migración.

### EndMigration

Finaliza la migración: elimina la centinela, restaura el estado del producto y programa la reordenación final de opciones:

```csharp
async Task EndMigration(ElsaShared.Data.Shopify.Product dbProduct, string centinelaId,
                        Dictionary<ShopifyId, List<string>> productOptions)
{
    // 1. Eliminar la variante centinela
    var resultadoEliminacionCentinela = await _shopifySdk.Products.Variants.BulkDelete(
        new Dictionary<string, string[]> { { dbProduct.DestinoId, [centinelaId] } });
    if (resultadoEliminacionCentinela.First()?.UserErrors is { Count: > 0 })
        throw new Exception($"Error al eliminar la variante centinela...");

    // 2. Restaurar el estado original (ACTIVE si era ACTIVE antes de poner en borrador)
    var originalStatus = originalProductsStatuses
        .SingleOrDefault(x => x.Id == dbProduct.DestinoId);
    if (originalStatus is { Status: not ProductStatus.DRAFT })
    {
        _ = await _shopifySdk.Products.Update(new ProductUpdateInput
        {
            Id = originalStatus.Id,
            Status = originalStatus.Status
        });
    }

    // 3. Añadir a la lista de reordenación
    _input.ProductOptionsAndValuesToReorder ??=
        new Dictionary<ShopifyId, Dictionary<ShopifyId, List<string>>>();
    if (_input.ProductOptionsAndValuesToReorder.ContainsKey(dbProduct.DestinoId))
    {
        // Si ya estaba (de una migración previa), reemplazar
        _input.ProductOptionsAndValuesToReorder.Remove(dbProduct.DestinoId);
    }
    _input.ProductOptionsAndValuesToReorder.Add(dbProduct.DestinoId, productOptions);
}
```

La escritura en `_input.ProductOptionsAndValuesToReorder` aprovecha que el `RunAsync` del loader ejecuta `ProcessProductOptionsAndValuesToReorder` justo después de `ProcessRebuildProductOptions`. El paso de reordenación recoge automáticamente todos los productos migrados.

---

## 3. ProductsWithVariantsDelete — RemoveProductsIfLastVariants

**Fichero:** `Loaders/Shopify/Products/ProductsWithVariantsDelete.cs`

Se ejecuta **antes** de cualquier borrado. Detecta si alguna variante a borrar es la única del producto y, en ese caso, promueve el borrado del producto completo:

```csharp
public async Task<ActivityResult> RemoveProductsIfLastVariants()
{
    if (_input.VariantsToDelete is not { Count: > 0 })
        return result;

    var inputProductsWithVariantsToDelete = _input.VariantsToDelete.Keys.ToHashSet();
    var dbProductsWithVariantsToDelete =
        await _transactionsService.Products.GetAllDicDestinoIds(inputProductsWithVariantsToDelete);

    // Iterar en reverso para poder modificar el diccionario durante la iteración
    for (var i = _input.VariantsToDelete.Count - 1; i >= 0; i--)
    {
        var inputProduct = _input.VariantsToDelete.ElementAt(i).Key;    // ShopifyId producto
        var inputVariants = _input.VariantsToDelete.ElementAt(i).Value; // ShopifyIds variantes

        var dbProduct = dbProductsWithVariantsToDelete
            .Where(x => x.Key == inputProduct).Select(x => x.Key).SingleOrDefault();
        var dbVariants = dbProductsWithVariantsToDelete
            .Where(x => x.Key == inputProduct).Select(x => x.Value).SingleOrDefault();
        if (dbProduct is null || dbVariants is null) continue;

        // Si TODAS las variantes conocidas en BD están en la lista de borrado → borrar el producto
        if (dbVariants.All(input => inputVariants.Contains(input)))
        {
            _input.VariantsToDelete.Remove(inputProduct);   // quitar de variantes
            _input.ProductsToDelete ??= [];
            if (!_input.ProductsToDelete.Contains(inputProduct))
                _input.ProductsToDelete.Add(inputProduct);  // promover a borrado de producto
        }
    }

    return result;
}
```

**Por qué iterar en reverso:** el bucle modifica `_input.VariantsToDelete` durante la iteración (elimina entradas). Iterar de mayor a menor índice evita saltarse elementos al reducirse el tamaño de la colección.

**La lógica de promoción:** `dbVariants.All(input => inputVariants.Contains(input))` compara el estado de la BD (todas las variantes que el sistema conoce para ese producto) contra la lista de borrado. Si todas coinciden, el producto se quedaría sin variantes tras el borrado — Shopify rechazaría esa operación, así que se promueve al borrado completo del producto.

---

## 4. CompaniesWithContactsLoader — CreateCompanies

**Fichero:** `Loaders/Shopify/Companies/CompaniesWithContactsLoader.cs`

Crea empresas B2B en Shopify con su primera location y sus contactos, en secuencia coordinada y en paralelo entre companies:

```csharp
public async Task<ActivityResult> CreateCompanies(
    Dictionary<OriginInput<CompanyInput>,
               (OriginInput<CompanyContactInput>[]? Contacts,
                OriginInput<CompanyLocationInput>[] Locations)>? companies)
{
    var tasks = companies.Select(async company =>
    {
        using var scope = _serviceProvider.CreateScope();
        var transactionsService = scope.ServiceProvider.GetRequiredService<TransactionsService>();

        if (company.Value.Locations.Length == 0)
        {
            // LogError: company sin locations → no se puede crear
            return;
        }

        // 1. Crear la company con su PRIMERA location en una sola llamada CompanyCreate
        var originCompanyInput = new OriginInput<CompanyCreateInput>
        {
            OriginId = company.Key.OriginId,
            Input = new CompanyCreateInput
            {
                Company         = company.Key.Input,
                CompanyLocation = company.Value.Locations.First().Input // ← primera location
            }
        };
        var createCompanyResult = await _shopifySdk.Companies.Create(originCompanyInput.Input);
        var resultCompanyCreate = await transactionsService.Companies.AddCompany(
            createCompanyResult, originCompanyInput);

        if (!resultCompanyCreate.ok) return; // si falla, no crear locations ni contactos

        // 2. Crear las locations adicionales (las que van después de la primera)
        if (company.Value.Locations.Length > 1)
        {
            var locationsToCreate = new Dictionary<string, OriginInput<CompanyLocationInput>[]>
            {
                {
                    createCompanyResult.Company!.Id!,
                    company.Value.Locations.Skip(1).ToArray()  // ← saltar la primera
                }
            };
            result += await CreateLocations(locationsToCreate);
        }

        // 3. Crear los contactos y asignar MainContact
        if (company.Value.Contacts?.Length > 0)
        {
            var contactsToCreate = new Dictionary<string, OriginInput<CompanyContactInput>[]>
            {
                { createCompanyResult.Company!.Id!, company.Value.Contacts.ToArray() }
            };
            result += await CreateContacts(contactsToCreate);

            // El primer contacto de la lista es el MainContact
            var inputMainContact = company.Value.Contacts.First();
            var mainContactDb = contactsDb.FirstOrDefault(
                x => x.OrigenId == inputMainContact.OriginId);
            if (mainContactDb != null)
            {
                var companyAssignMainContact =
                    await _shopifySdk.Companies.Contacts.AssignMainContact(
                        mainContactDb.DestinoId, createCompanyResult.Company.Id!);
                result += await transactionsService.Companies.Contacts.AssignMainContact(
                    companyAssignMainContact, inputMainContact.OriginId);
            }
        }
    });

    await Task.WhenAll(tasks);
}
```

Las companies se crean **en paralelo** con `Task.WhenAll`. Cada tarea crea su propio scope de DI (`_serviceProvider.CreateScope()`) para obtener un `TransactionsService` con su propio `DbContext` independiente — EF Core no es thread-safe con un único `DbContext` compartido.

### DeleteCompanies y RemoveContactsFromCompanies

Shopify no permite borrar una company si tiene contactos asociados. El código desasocia todos sus contactos antes de borrar:

```csharp
public async Task<ActivityResult> DeleteCompanies(string[] companiesIds)
{
    ActivityResult result = new();

    // 1. Desasociar TODOS los contactos de las companies a borrar
    result += await RemoveContactsFromCompanies(companiesIds);

    // Modo especial: si solo queremos desasociar sin borrar
    if (_input.DeleteCompaniesOnlyRemoveContacts)
        return result;

    // 2. Borrar en lotes de 50 (paralelo)
    const int batchSize = 50;
    List<Task<ActivityResult>> tasks = [];
    for (int i = 0; i < companiesIds.Length; i += batchSize)
    {
        var chunk = companiesIds.Skip(i).Take(batchSize).ToArray();
        var task = Task.Run(async () =>
        {
            var deleteCompaniesResult = await _shopifySdk.Companies.Delete(chunk);
            using var scope = _serviceProvider.CreateScope();
            var transactionsService = scope.ServiceProvider.GetRequiredService<TransactionsService>();
            return await transactionsService.Companies.DeleteCompanies(chunk, deleteCompaniesResult);
        });
        tasks.Add(task);
    }
    var results = await Task.WhenAll(tasks);
    result += results.Aggregate((a, b) => a + b);

    return result;
}

private async Task<ActivityResult> RemoveContactsFromCompanies(string[] companiesIds)
{
    // Buscar en BD todos los contactos de esas companies
    var contacts = await _transactionsService.Companies.Contacts
        .GetByCompanyDestinoIds(companiesIds.ToHashSet());
    var contactIds = contacts
        .Select(x => x.DestinoId)
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct()
        .ToArray();

    if (contactIds.Length == 0) return result;

    List<(string CompanyContactId, CompanyContactRemoveFromCompanyPayload Output)> outputs = [];
    foreach (var contactId in contactIds)
    {
        var output = await _shopifySdk.Companies.CompanyContactRemoveFromCompany(contactId);
        outputs.Add((contactId, output));
    }

    result += await _transactionsService.Companies.Contacts.RemoveFromCompanies(outputs.ToArray());
    return result;
}
```

`DeleteCompaniesOnlyRemoveContacts` es un modo especial que solo desasocia los contactos sin borrar la company. Útil para operaciones de limpieza parcial o cuando se quiere reasignar contactos antes del borrado.

---

## 5. CompaniesWithContactsLoader — CreateMetafields

**Fichero:** `Loaders/Shopify/Companies/CompaniesWithContactsLoader.cs`

Crea o actualiza metafields de companies, locations y customers. La complejidad está en que los metafields llegan con `OriginId` (código del ERP) pero la API de Shopify necesita el `ShopifyId` del owner:

```csharp
public async Task<ActivityResult> CreateMetafields(MetafieldSet[] metafields,
                                                   CancellationToken cancellationToken = default)
{
    var metafieldsInput     = new List<MetafieldsSetInput>();
    var nullValuedMetafields = new List<MetafieldIdentifierInput>();

    // 1. Separar por tipo de entidad y resolver OriginId → ShopifyId
    var metafieldsCompany  = metafields.Where(x => x.Type == MetafieldOwnerType.COMPANY).ToList();
    var metafieldsLocation = metafields.Where(x => x.Type == MetafieldOwnerType.COMPANY_LOCATION).ToList();
    var metafieldsCustomer = metafields.Where(x => x.Type == MetafieldOwnerType.CUSTOMER).ToList();

    if (metafieldsCompany.Count > 0)
    {
        var companiesShopifyIds = await _transactionsService.Companies
            .FindShopifyIds(metafieldsCompany.Select(x => x.OrigenIdEntidad).ToHashSet());
        metafieldsInput.AddRange(
            TransformMetafieldsInput(companiesShopifyIds!, metafieldsCompany, nullValuedMetafields));
    }
    if (metafieldsLocation.Count > 0)
    {
        var locationShopifyIds = await _transactionsService.Companies.Locations
            .FindShopifyIds(metafieldsLocation.Select(x => x.OrigenIdEntidad).ToHashSet());
        metafieldsInput.AddRange(
            TransformMetafieldsInput(locationShopifyIds!, metafieldsLocation, nullValuedMetafields));
    }
    if (metafieldsCustomer.Count > 0)
    {
        var customerShopifyIds = await _transactionsService.Companies.Customers
            .FindShopifyIds(metafieldsCustomer.Select(x => x.OrigenIdEntidad).ToHashSet());
        metafieldsInput.AddRange(
            TransformMetafieldsInput(customerShopifyIds!, metafieldsCustomer, nullValuedMetafields));
    }

    // 2. Eliminar los metafields con valor nulo (la API no acepta set con valor vacío)
    var distinctNullValuedMetafields = nullValuedMetafields
        .GroupBy(x => $"{x.OwnerId}|{x.Namespace}|{x.Key}")
        .Select(x => x.First())
        .ToList();
    if (distinctNullValuedMetafields.Count > 0)
    {
        var deleteMetafieldsResult =
            await _shopifySdk.Metafields.Delete(distinctNullValuedMetafields);
        // [procesar errores y logs]
    }

    // 3. Enviar los metafields con valor en lotes de 25 (límite de metafieldsSet de Shopify)
    const int batchSize = 25;
    var metafieldsArrayInput = new List<ICollection<MetafieldsSetInput>>();
    for (int i = 0; i < metafieldsInput.Count; i += batchSize)
        metafieldsArrayInput.Add(metafieldsInput.Skip(i).Take(batchSize).ToList());

    if (metafieldsArrayInput.Count == 0) return result;

    var createMetafieldsResult = await _shopifySdk.Metafields.BulkSet(
        metafieldsArrayInput, cancellationToken);
}
```

### TransformMetafieldsInput

Convierte cada `MetafieldSet` (con `OriginId` + valor del metafield) a `MetafieldsSetInput` (con `ShopifyId` del owner + valor). Separa los que tienen valor nulo para borrarlos en lugar de enviarlos:

```csharp
private List<MetafieldsSetInput> TransformMetafieldsInput(
    Dictionary<string, string> diccionarioIds,       // OriginId → ShopifyId
    List<MetafieldSet> metafields,
    List<MetafieldIdentifierInput> nullValuedMetafields)
{
    var metafieldsTransformados = new List<MetafieldsSetInput>();

    foreach (var metafield in metafields)
    {
        if (!diccionarioIds.TryGetValue(metafield.OrigenIdEntidad, out var ownerId))
        {
            _logger.LogError(
                "Ha fallado la transformación de metafields para el metafield {key} " +
                "de la entidad {origenId}. No se ha encontrado el owner en transactions.",
                metafield.MetafieldsSetInput.Key, metafield.OrigenIdEntidad);
            continue; // owner no está en BD → descartar
        }

        var metafieldInput = new MetafieldsSetInput
        {
            Key       = metafield.MetafieldsSetInput.Key,
            Namespace = metafield.MetafieldsSetInput.Namespace,
            OwnerId   = ownerId,   // ← ShopifyId resuelto desde BD
            Type      = metafield.MetafieldsSetInput.Type,
            Value     = metafield.MetafieldsSetInput.Value
        };

        if (string.IsNullOrWhiteSpace(metafieldInput.Value))
        {
            // Valor nulo → acumular para borrado explícito con Metafields.Delete()
            nullValuedMetafields.Add(new MetafieldIdentifierInput
            {
                Key       = metafieldInput.Key,
                Namespace = metafieldInput.Namespace,
                OwnerId   = metafieldInput.OwnerId
            });
        }
        else
        {
            metafieldsTransformados.Add(metafieldInput);
        }
    }

    return metafieldsTransformados;
}
```

El patrón "valor nulo → borrar explícitamente" también se aplica en `ProductsWithVariantsUpdate.UpdateProducts()` y `UpdateVariants()`. La razón es que la API de Shopify rechaza `metafieldsSet` con valores vacíos — hay que usar `Metafields.Delete()` con el identificador completo (OwnerId + Namespace + Key).

---

## 6. SyncCompanies — RunAsync y fases

**Fichero:** `Loaders/Shopify/Mirror/SyncCompanies.cs`

El Mirror más completo. Descarga todos los datos de companies de Shopify en un único stream bulk y los clasifica antes de procesarlos en 7 fases secuenciales:

```csharp
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var allCompanies = await shopifySdk.Companies.BulkGetAll();

    // Clasificar el stream por tipo de objeto
    var companies    = new List<Company>();
    var companyContacts = new List<CompanyContact>();
    var companyLocations = new List<CompanyLocation>();
    var roleAssigments = new List<CompanyContactRoleAssignment>();

    allCompanies.ForEach(item => {
        JObject itemJobject = item as JObject;
        string idValue = itemJobject.First.First.Value<string>(); // campo "id" = tipo del objeto

        if      (idValue.Contains("CompanyContactRoleAssignment"))
            roleAssigments.Add(JsonConvert.DeserializeObject<CompanyContactRoleAssignment>(...));
        else if (idValue.Contains("CompanyContact"))
            companyContacts.Add(JsonConvert.DeserializeObject<CompanyContact>(...));
        else if (idValue.Contains("CompanyLocation"))
            companyLocations.Add(JsonConvert.DeserializeObject<CompanyLocation>(...));
        else
            companies.Add(JsonConvert.DeserializeObject<Company>(...));
    });

    // Fases
    result = await ProccessCompanies(context, companies, result);           // Fase 1
    result = await ProcessCompanyContacts(context, companyContacts, result); // Fase 2
    result = await ProcessLocations(context, companyLocations, result);      // Fase 3
    result = await ProcessRoles(context, companyLocations, roleAssigments, result); // Fase 4
    await ConvertEmails(context);                                             // Fase 5
    if (!string.IsNullOrEmpty(agentQuery))
        result += await ProcessAgents(context, agents);                       // Fase 6
    result += await ProcessCustomersWithoutCompany(context, customersWithoutCompany); // Fase 7
}
```

**Clasificación del stream:** La API devuelve todos los objetos en un único JSON Lines stream. El código los clasifica inspeccionando el **primer campo** de cada `JObject`, que siempre es el campo `id`. El valor de ese `id` incluye el tipo: `gid://shopify/Company/123`, `gid://shopify/CompanyContact/456`, etc.

### Fase 1 — ProccessCompanies

Hace un `GroupJoin` entre los `ExternalId` de Shopify y los `OrigenId` de la BD. Para cada company:

- **No existe en BD** → crear registro con `DestinoId`, `DefaultRole` y `MainContact.Customer`
- **Existe con `DestinoId` diferente** → actualizar `DestinoId` (la company fue recreada en Shopify manteniendo el `ExternalId`)
- **Existe en BD pero no en Shopify** → borrar la company y todos sus `CompanyContacts` de la BD

```csharp
// Borrar de BD las companies que ya no existen en Shopify
foreach (var companyDb in transactionsDbContext.Companies)
{
    var company = companies.FirstOrDefault(
        x => x.ExternalId != null && x.ExternalId.Equals(companyDb.OrigenId));

    if (company == null)
    {
        var contactsByCompany = transactionsDbContext.CompanyContacts
            .Where(x => x.CompanyAsMainContactId == companyDb.Id ||
                        x.CompanyAsContactId == companyDb.Id);
        await contactsByCompany.ExecuteDeleteAsync();
        transactionsDbContext.Companies.Remove(companyDb);
        await transactionsDbContext.SaveChangesAsync();
    }
}
```

### Fase 2 — ProcessCompanyContacts

Upsert de contactos por email (en minúsculas). Tres casos especiales:
- Si el `DestinoId` existe en BD pero el `OrigenId` (email) no coincide → corregir el `OrigenId`
- Si el contact fue reasignado a otra company → actualizar `CompanyAsMainContactId` / `CompanyAsContactId`
- Si el contact no existe en Shopify → borrar de BD

### Fase 3 — ProcessLocations

Igual que companies pero usando `ExternalId` como `OrigenId`. Si una location no tiene `ExternalId` en Shopify, el código genera un identificador temporal basado en ticks del reloj (`$"__{DateTime.Now.Ticks}"`) para poder registrarla sin perder la relación con su company.

### Fase 4 — ProcessRoles

Construye el `OrigenId` del rol como `"{locationExternalId}-{contactEmail}"` (todo en minúsculas):

```csharp
// Fórmula del OrigenId de un rol en SyncCompanies
rol.OrigenId = $"{locationOriginId}-{companyContactDb.OrigenId}".Trim().ToLower();
```

Esta misma fórmula se usa en [`CustomerDecision.TryAddRole`](04d-decisions-metodos.md#tryaddrole) para detectar duplicados antes de crear el rol. La consistencia entre ambas fórmulas es lo que permite que el Decision y el Mirror se mantengan sincronizados.

Para cada `CompanyContactRoleAssignment` de Shopify:
- **Ya existe en BD con otro `OrigenId`** → detectar conflicto, borrar el antiguo, actualizar al nuevo
- **Ya existe en BD con mismo `OrigenId`** → actualizar `Referencia` (nombre de la location)
- **No existe en BD** → crear

### Fases 5-7

| Fase | Método | Qué hace |
|---|---|---|
| 5 | `ConvertEmails` | Normaliza a minúsculas todos los `OriginIds` de Customers en BD (corrección histórica) |
| 6 | `ProcessAgents` | Busca en Shopify los customers con los tags de `ShopifyCredentials:AgentTags` y los registra en BD con `IsAgent = true` |
| 7 | `ProcessCustomersWithoutCompany` | Registra en BD los customers de Shopify sin empresa asociada (para asignación de tags o roles especiales) |

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [`10-loaders.md`](10-loaders.md) | Visión general: qué hace cada loader y qué escribe en Shopify |
| [`10b-loaders-detalle.md`](10b-loaders-detalle.md) | Campos de los modelos de input y sub-operaciones con referencias cruzadas |
