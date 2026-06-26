---
tags:
  - Decisions
  - ERP
  - PIM
---

# 04d — Decisions: métodos y funciones en detalle

Este documento explica paso a paso el código de cada Decision. Cuando en [`04d-decisions.md`](04d-decisions.md) se mencione un método concreto, puedes venir aquí y leer el código completo con su explicación.

---

## Índice

1. [ProductsDecision — RunAsync](#1-productsdecision-runasync)
2. [ProductsRebuildDecision — RunAsync](#2-productsrebuilddecision-runasync)
3. [CustomerDecision — RunAsync](#3-customerdecision-runasync)
4. [ImageDecision — RunAsync](#4-imagedecision-runasync)
5. [PriceListDecision — RunAsync](#5-pricelistdecision-runasync)

---

## 1. ProductsDecision — RunAsync

**Fichero:** `UPG.Pataky.Shared/Shared/Activities/Decisions/ProductDecision.cs`

Versión base de la decisión de productos. Clasifica productos y variantes en tres operaciones (crear / actualizar / borrar) consultando la BD de transacciones.

```csharp
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var transactionsService = context.GetRequiredService<TransactionsService>();

    var productosCrear      = new List<IProduct>();
    var productosEliminar   = new List<OrigenId>();
    var productosActualizar = new List<IProduct>();

    var variantesCrear      = new List<IVariant>();
    var variantesActualizar = new List<IVariant>();
    var variantesEliminar   = new List<OrigenId>();

    await _productos.ForEachAsync(async product =>
    {
        try
        {
            // Si el producto viene marcado como Deleted, lo saltamos
            // (el diff final lo añadirá a productosEliminar si existía en BD)
            if (product.Status == EntityStatus.Deleted)
            {
                productosEliminar.Add(product.OriginId);
                return;
            }

            // Comprobar si el producto padre ya existe en Shopify
            if (await transactionsService.Products.ExistsProductByOriginId(product.OriginId))
            {
                // Producto existente → actualizar
                productosActualizar.Add(product);

                // Clasificar sus variantes
                await product.GetVariants().ForEachAsync(async variant =>
                {
                    try
                    {
                        if (variant.Status == EntityStatus.Deleted)
                        {
                            variantesEliminar.Add(variant.OriginId);
                            return;
                        }

                        if (await transactionsService.Products.Variants.ExistsVariantByOriginId(variant.OriginId))
                            variantesActualizar.Add(variant);
                        else
                            variantesCrear.Add(variant);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex,
                            "Ha fallado la decisión para la variante {variantOriginId} del producto {productOriginId}.",
                            variant.OriginId, product.OriginId);
                    }
                });
            }
            else
            {
                // Producto nuevo → crear (con todas sus variantes)
                productosCrear.Add(product);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Ha fallado la decisión para el producto {productOriginId}.", product.OriginId);
        }
    });

    // Diff final: productos y variantes que están en BD pero no han llegado del PIM → borrar
    List<OrigenId> dbProductOriginIds = await transactionsService.Products.GetAllOriginIds();
    List<OrigenId> dbVariantOriginIds = await transactionsService.Products.Variants.GetAllOriginIds();

    productosEliminar = dbProductOriginIds
        .Where(x => !_productos.Any(y => y.OriginId.Equals(x)))
        .ToList();

    List<OrigenId> variantOriginIds = _productos
        .SelectMany(x => x.GetVariants().Select(y => y.OriginId))
        .ToList();
    variantesEliminar = dbVariantOriginIds
        .Where(x => !variantOriginIds.Any(y => y.Equals(x)))
        .ToList();

    ProductosCrear.Set(context,     new Box<IProduct>(productosCrear));
    ProductosActualizar.Set(context, new Box<IProduct>(productosActualizar));
    ProductosBorrar.Set(context,    new Box<OrigenId>(productosEliminar));
    VariantesCrear.Set(context,     new Box<IVariant>(variantesCrear));
    VariantesActualizar.Set(context, new Box<IVariant>(variantesActualizar));
    VariantesBorrar.Set(context,    new Box<OrigenId>(variantesEliminar));

    return new()
    {
        InformationLogs =
        [
            $"Recuperados {productosCrear.Count} productos para crear.",
            $"Recuperados {productosActualizar.Count} productos para actualizar.",
            $"Recuperados {productosEliminar.Count} productos para eliminar.",
            $"Recuperados {variantesCrear.Count} variantes para crear.",
            $"Recuperados {variantesActualizar.Count} variantes para actualizar.",
            $"Recuperados {variantesEliminar.Count} variantes para eliminar."
        ]
    };
}
```

**Flujo de decisión en tres fases:**

```text
Fase 1 — Clasificar productos entrantes
   Para cada producto del PIM:
     Status == Deleted  →  (anotado, pero el diff final lo sobrescribe)
     Existe en BD       →  productosActualizar
                            + clasificar variantes individualmente
     No existe en BD    →  productosCrear (con todas sus variantes)

Fase 2 — Clasificar variantes de productos existentes
   Para cada variante de un producto que se va a actualizar:
     Status == Deleted  →  variantesEliminar
     Existe en BD       →  variantesActualizar
     No existe en BD    →  variantesCrear

Fase 3 — Diff para detectar borrados por desaparición
   Productos en BD que no están en el input del PIM → productosEliminar
   Variantes en BD que no están en ningún producto  → variantesEliminar
```

> **Nota:** En esta versión, la lista `productosEliminar` construida en la fase 1 (para los productos con `Status == Deleted`) es **sobrescrita** en la fase 3 por el diff. El resultado final es el mismo porque un producto marcado como `Deleted` tampoco aparecería en el input del PIM en la próxima sincronización, pero la lógica explícita de la fase 1 queda sin efecto. `ProductsRebuildDecision` corrige esto usando `UnionWith` en lugar de asignación.

---

## 2. ProductsRebuildDecision — RunAsync

**Fichero:** `UPG.Pataky.Shared/Shared/Activities/Decisions/ProductsRebuildDecision.cs` y `Decisions/ProductsRebuildDecision.cs`

Versión mejorada de `ProductsDecision`. Añade cuatro capacidades que la versión base no tiene:

1. **Detección de cambio de opciones** → `RebuildProductOptions`
2. **Límite de variantes** → descarta productos con más de 2048 variantes
3. **Promoción a borrado de producto** → si todas las variantes de un producto se van a borrar, borra el producto directamente
4. **Supresión de borrado de variantes** → cuando un producto ya va a borrarse, no se borran sus variantes individualmente

```csharp
private const int MaxNumVariants = 2048;

protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var transactionsService = context.GetRequiredService<TransactionsService>();

    var productosCrear         = new List<IProduct>();
    var productosActualizar    = new List<IProduct>();
    var productosEliminar      = new HashSet<OrigenId>();  // HashSet evita duplicados

    var variantesCrear         = new List<IVariant>();
    var variantesActualizar    = new List<IVariant>();
    var variantesEliminar      = new HashSet<OrigenId>();

    var rebuildProductOptions  = new List<IProduct>();

    // ── Filtro de productos con demasiadas variantes ──────────────────────
    var exceededMaxNumVariants = _productos.RemoveAllAndGetRemoved(
        p => p.GetVariants().Count > MaxNumVariants);

    // ── Cargar BD de una sola vez (más eficiente que consultas por elemento) ──
    var dbProducts           = await transactionsService.Products.Get();
    var dbProductsByOriginId = dbProducts.ToDictionary(x => x.OrigenId);
    var dbProductOriginIds   = dbProductsByOriginId.Keys.ToHashSet();
    var dbVariantOriginIds   = dbProducts
        .SelectMany(x => x.Variants.Select(v => v.OrigenId))
        .ToHashSet();

    var currentProductOriginIds = _productos.Select(x => x.OriginId).ToHashSet();
    var currentVariantOriginIds = _productos
        .SelectMany(x => x.GetVariants().Select(v => v.OriginId))
        .ToHashSet();

    // ── Clasificar productos ──────────────────────────────────────────────
    foreach (var product in _productos)
    {
        try
        {
            dbProductsByOriginId.TryGetValue(product.OriginId, out var dbProduct);

            // Marcado como eliminado: borrar solo si existe en BD
            if (product.Status == EntityStatus.Deleted)
            {
                if (dbProduct is not null)
                    productosEliminar.Add(product.OriginId);
                continue;
            }

            // Inactivo y no existe en BD: ignorar completamente
            if (product.Status == EntityStatus.Inactive && dbProduct is null)
                continue;

            // No existe en BD → crear
            if (dbProduct is null)
            {
                productosCrear.Add(product);
                continue;
            }

            // Existen en BD pero han cambiado sus opciones → reconstruir
            var productOptionNames   = product.GetSortedOptions().Keys.ToHashSet();
            var dbProductOptionNames = dbProduct.Options.Select(x => x.Referencia).ToHashSet();
            if (!productOptionNames.SetEquals(dbProductOptionNames))
            {
                rebuildProductOptions.Add(product);
                continue;
            }

            // Actualizar producto
            productosActualizar.Add(product);

            // Clasificar variantes
            foreach (var variant in product.GetVariants())
            {
                try
                {
                    if (variant.Status == EntityStatus.Deleted)
                    {
                        variantesEliminar.Add(variant.OriginId);
                        continue;
                    }
                    if (!dbVariantOriginIds.Contains(variant.OriginId))
                        variantesCrear.Add(variant);
                    else
                        variantesActualizar.Add(variant);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex,
                        "Ha fallado la decisión para la variante {variantOriginId} del producto {productOriginId}.",
                        variant.OriginId, product.OriginId);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Ha fallado la decisión para el producto {productOriginId}.", product.OriginId);
        }
    }

    // ── Diff final: detectar desapariciones ──────────────────────────────
    // UnionWith en lugar de asignación: conserva los Deleted detectados arriba
    productosEliminar.UnionWith(dbProductOriginIds.Except(currentProductOriginIds));
    variantesEliminar.UnionWith(dbVariantOriginIds.Except(currentVariantOriginIds));

    // ── Promoción y supresión ─────────────────────────────────────────────
    var productsMovedToDelete = 0;
    var productsWithSuppressedVariantDeletes = 0;

    foreach (var dbProduct in dbProducts)
    {
        var productVariantOriginIds = dbProduct.Variants.Select(x => x.OrigenId).ToHashSet();
        if (productVariantOriginIds.Count == 0) continue;

        var productOriginId      = dbProduct.OrigenId;
        var productAlreadyDeleting = productosEliminar.Contains(productOriginId);

        // Si todas las variantes van a borrarse → promover a borrado de producto
        if (!productAlreadyDeleting && productVariantOriginIds.All(variantesEliminar.Contains))
        {
            productosEliminar.Add(productOriginId);
            productosActualizar.RemoveWhere(x => x.OriginId == productOriginId);
            variantesCrear.RemoveWhere(x => x.ProductOriginId == productOriginId);
            productsMovedToDelete++;
            productAlreadyDeleting = true;
        }

        // Si el producto ya va a borrarse → no borrar sus variantes por separado
        if (productAlreadyDeleting && variantesEliminar.Overlaps(productVariantOriginIds))
        {
            variantesEliminar.ExceptWith(productVariantOriginIds);
            productsWithSuppressedVariantDeletes++;
        }
    }

    // ── Set outputs ───────────────────────────────────────────────────────
    ProductosCrear.Set(context,        new Box<IProduct>(productosCrear));
    ProductosActualizar.Set(context,   new Box<IProduct>(productosActualizar));
    ProductosBorrar.Set(context,       new Box<OrigenId>(productosEliminar.ToList()));
    VariantesCrear.Set(context,        new Box<IVariant>(variantesCrear));
    VariantesActualizar.Set(context,   new Box<IVariant>(variantesActualizar));
    VariantesBorrar.Set(context,       new Box<OrigenId>(variantesEliminar.ToList()));
    RebuildProductOptions.Set(context, new Box<IProduct>(rebuildProductOptions));

    var activityResult = new ActivityResult()
    {
        InformationLogs =
        [
            $"Recuperados {productosCrear.Count} productos para crear.",
            $"Recuperados {productosActualizar.Count} productos para actualizar.",
            $"Se van a reconstruir las opciones de {rebuildProductOptions.Count} productos.",
            $"Recuperados {productosEliminar.Count} productos para eliminar.",
            $"Se han movido {productsMovedToDelete} productos a borrado porque se intentaban eliminar todas sus variantes.",
            $"Se han retirado las variantes de {productsWithSuppressedVariantDeletes} productos marcados para borrar.",
            $"Recuperados {variantesCrear.Count} variantes para crear.",
            $"Recuperados {variantesActualizar.Count} variantes para actualizar.",
            $"Recuperados {variantesEliminar.Count} variantes para eliminar."
        ]
    };

    if (exceededMaxNumVariants.Count > 0)
        activityResult.ErrorLogs.Add(
            $"Se han descartado {exceededMaxNumVariants.Count} productos ya que superan las {MaxNumVariants} variantes.");

    return activityResult;
}
```

**Las cuatro capacidades adicionales respecto a `ProductsDecision`:**

**1. Detección de cambio de opciones**

```csharp
var productOptionNames   = product.GetSortedOptions().Keys.ToHashSet();
var dbProductOptionNames = dbProduct.Options.Select(x => x.Referencia).ToHashSet();
if (!productOptionNames.SetEquals(dbProductOptionNames))
    rebuildProductOptions.Add(product);
```

`GetSortedOptions()` devuelve el esquema de opciones actual del producto (ej: `{"Color", "Talla"}`). Si ese esquema difiere del que está guardado en la BD (el que se usó la última vez que se sincronizó en Shopify), el producto va a `RebuildProductOptions` en lugar de `ProductosActualizar`. El transformer de actualización detecta esta lista y genera una operación de reconstrucción completa de opciones y variantes.

**2. Límite de 2048 variantes**

```csharp
var exceededMaxNumVariants = _productos.RemoveAllAndGetRemoved(
    p => p.GetVariants().Count > MaxNumVariants);
```

Shopify impone un límite de 2000 variantes por producto. Los productos que lo superen se eliminan del input antes de que empiece la clasificación y se loguea un error.

**3. Promoción a borrado de producto**

```csharp
if (!productAlreadyDeleting && productVariantOriginIds.All(variantesEliminar.Contains))
{
    productosEliminar.Add(productOriginId);
    ...
    productsMovedToDelete++;
}
```

Si todas las variantes de un producto van a borrarse, en lugar de borrar N variantes individualmente se promueve a borrar el producto entero. Es más eficiente y evita estados intermedios inválidos en Shopify (un producto sin variantes).

**4. Supresión de borrado de variantes redundante**

```csharp
if (productAlreadyDeleting && variantesEliminar.Overlaps(productVariantOriginIds))
{
    variantesEliminar.ExceptWith(productVariantOriginIds);
    productsWithSuppressedVariantDeletes++;
}
```

Cuando un producto ya va a borrarse, no tiene sentido borrar sus variantes por separado — al borrar el producto padre Shopify borra sus variantes automáticamente. Se eliminan de `variantesEliminar` para evitar llamadas redundantes a la API.

---

## 3. CustomerDecision — RunAsync

**Fichero:** `UPG.Pataky.Shared/Shared/Activities/Decisions/CustomerDecision.cs`

El más complejo de los cinco. Gestiona una jerarquía a tres niveles (Company → Location → Customer/Contact) y produce 9 outputs distintos.

### `TryAddRole`

Función local definida dentro del `RunAsync` que evita duplicar asignaciones de rol:

```csharp
var roleIds = new HashSet<string>(rolesDb.Select(r => r.OrigenId));

void TryAddRole(ICustomer customer, ILocation location)
{
    var roleId = customer.GetRoleOriginId(location);

    if (!roleIds.Add(roleId))  // Add devuelve false si ya existía
        return;

    roleCreate.Add(Tuple.Create(customer, location));
}
```

Carga todos los OriginIds de roles existentes en un `HashSet` al inicio. `HashSet.Add()` devuelve `false` si el elemento ya existe, por lo que la función es idempotente: nunca añade el mismo par `(customer, location)` dos veces aunque se llame desde múltiples puntos del código.

### Bucle principal

```csharp
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    // ... inicialización de listas ...

    var transactionsService = context.GetRequiredService<TransactionsService>();
    var companiesBbDd = await transactionsService.Companies.Get();
    var locationsBbDd = await transactionsService.Companies.Locations.Get();
    var contactsDB    = await transactionsService.Companies.Contacts.Get();
    var rolesDb       = await transactionsService.Companies.Roles.Get();

    var roleIds = new HashSet<string>(rolesDb.Select(r => r.OrigenId));

    void TryAddRole(ICustomer customer, ILocation location) { /* ver arriba */ }

    _companiesInput.ForEach(company =>
    {
        var companyDb = companiesBbDd.FirstOrDefault(x => x.OrigenId == company.OriginId);

        if (companyDb != null)
        {
            // ── Company existente ─────────────────────────────────────────

            if (company.Status != EntityStatus.Active)
            {
                // Company inactiva → borrar
                companiesDelete.Add(companyDb.DestinoId);
                return;
            }

            // Actualizar company
            companiesEdit.Add(Tuple.Create(companyDb.DestinoId, company));

            ICollection<ICustomer> customersCompany = company.GetCustomers();
            List<CompanyContact> companyContacts = contactsDB
                .Where(x => x.CompanyAsContactId == companyDb.Id
                         || x.CompanyAsMainContactId == companyDb.Id)
                .ToList();

            company.GetLocations().ForEach(location =>
            {
                var locationDb = locationsBbDd.FirstOrDefault(
                    x => x.CompanyId == companyDb.Id && x.OrigenId == location.OriginId);

                if (locationDb != null)
                {
                    if (location.Status != EntityStatus.Active)
                    {
                        locationDelete.Add(locationDb);
                        return;
                    }

                    // Actualizar location existente
                    locationEdit.Add(Tuple.Create(locationDb.DestinoId, location));

                    // Clasificar contactos de esta location
                    location.GetCustomers()?.ForEach(customerLocation =>
                    {
                        var customerEditDB = contactsDB.FirstOrDefault(
                            x => x.OrigenId == customerLocation.OriginId);

                        if (customerEditDB != null)
                        {
                            // No duplicar si ya está en la lista de edición
                            if (!customerEdit.Any(x => x.Item1 == customerEditDB.DestinoId
                                                    && x.Item2.OriginId == customerLocation.OriginId))
                                customerEdit.Add(Tuple.Create(customerEditDB.DestinoId, customerLocation));
                        }
                        else
                        {
                            if (!customerCreate.Any(x => x.Item1 == companyDb.DestinoId
                                                      && x.Item2.OriginId == customerLocation.OriginId))
                                customerCreate.Add(Tuple.Create(companyDb.DestinoId, customerLocation));
                        }
                        TryAddRole(customerLocation, location);
                    });

                    // Contactos a nivel de company que también actúan en esta location
                    if (company.GetCustomers()?.Count() > 0)
                    {
                        company.GetCustomers().ForEach(customerLocation =>
                        {
                            var customerEditDB = contactsDB.FirstOrDefault(
                                x => x.OrigenId == customerLocation.OriginId);

                            if (customerEditDB != null)
                            {
                                if (!customerEdit.Any(x => x.Item1 == customerEditDB.DestinoId
                                                        && x.Item2.OriginId == customerLocation.OriginId))
                                    customerEdit.Add(Tuple.Create(customerEditDB.DestinoId, customerLocation));
                            }
                            else
                            {
                                if (!customerCreate.Any(x => x.Item1 == companyDb.DestinoId
                                                          && x.Item2.OriginId == customerLocation.OriginId))
                                    customerCreate.Add(Tuple.Create(companyDb.DestinoId, customerLocation));
                            }
                            TryAddRole(customerLocation, location);
                        });
                    }

                    // Acumular contactos de esta location en la lista total de la company
                    customersCompany = customersCompany.Concat(location.GetCustomers()).ToList();
                }
                else if (location.Status == EntityStatus.Active)
                {
                    // Location nueva dentro de company existente
                    locationCreate.Add(Tuple.Create(companyDb.DestinoId, location));

                    location.GetCustomers()?.ForEach(customerLocation =>
                    {
                        if (!customerCreate.Any(x => x.Item1 == companyDb.DestinoId
                                                  && x.Item2.OriginId == customerLocation.OriginId))
                            customerCreate.Add(Tuple.Create(companyDb.DestinoId, customerLocation));
                        TryAddRole(customerLocation, location);
                    });

                    company.GetCustomers()?.ForEach(customerLocation =>
                    {
                        if (!customerCreate.Any(x => x.Item1 == companyDb.DestinoId
                                                  && x.Item2.OriginId == customerLocation.OriginId))
                            customerCreate.Add(Tuple.Create(companyDb.DestinoId, customerLocation));
                        TryAddRole(customerLocation, location);
                    });
                }
                // location inactiva y no existe → ignorar
            });

            // Contactos a borrar: los que están en BD para esta company pero
            // ya no aparecen en ninguna location ni en los contactos de la company
            List<DestinoId> companyContactsDelete = companyContacts
                .Where(x => customersCompany.All(y => !x.Customer.IsAgent && y.OriginId != x.OrigenId))
                .Select(x => x.DestinoId)
                .ToList();
            customerDelete = customerDelete.Distinct().Concat(companyContactsDelete).ToList();

            // MainContact: asignar si difiere del que está en BD
            if (company.GetMainContact() != null
             && companyDb.MainContact?.OrigenId != company.GetMainContact()!.OriginId)
                mainContactAssign.Add(Tuple.Create(companyDb.DestinoId, company.GetMainContact()!));
        }
        else if (company.Status == EntityStatus.Active)
        {
            // ── Company nueva ─────────────────────────────────────────────
            companiesCreate.Add(company);

            // Roles para los contactos de nivel company en todas las locations
            if (company.GetCustomers()?.Count() > 0 && company.GetLocations()?.Count() > 0)
            {
                company.GetCustomers().ForEach(customer =>
                    company.GetLocations().ForEach(location =>
                        TryAddRole(customer, location)));
            }

            // Roles para los contactos de nivel location
            company.GetLocations()?.ForEach(location =>
                location.GetCustomers()?.ForEach(customer =>
                {
                    // Solo si no es ya contacto de company (evitar duplicar TryAddRole)
                    if (company.GetCustomers() == null
                     || !company.GetCustomers().Any(x => x.OriginId == customer.OriginId))
                        TryAddRole(customer, location);
                }));
        }
        // company inactiva y no existe → ignorar
    });

    // ── Diff final: companies y locations desaparecidas ───────────────────

    companiesBbDd.ForEach(companyDB =>
    {
        if (_companiesInput.FirstOrDefault(x => x.OriginId == companyDB.OrigenId) is null)
            companiesDelete.Add(companyDB.DestinoId);
    });

    var _locationsInput = _companiesInput.SelectMany(x => x.GetLocations()).ToList();

    locationsBbDd.ForEach(locationDB =>
    {
        if (_locationsInput.FirstOrDefault(x => x.OriginId == locationDB.OrigenId) is null)
            locationDelete.Add(locationDB);
    });

    // ── Set outputs ───────────────────────────────────────────────────────

    CreateCompanies.Set(context, new Box<ICompany>(companiesCreate.ToList()));
    UpdateCompanies.Set(context, new Box<(string, ICompany)>(
        companiesEdit.Select(t => (t.Item1, t.Item2)).ToList()));
    DeleteCompanies.Set(context, new Box<DestinoId>(companiesDelete.ToList()));

    CreateLocations.Set(context, new Box<(string, ILocation)>(
        locationCreate.Select(x => (x.Item1, x.Item2)).ToList()));
    UpdateLocations.Set(context, new Box<(string, ILocation)>(
        locationEdit.Select(x => (x.Item1, x.Item2)).ToList()));
    DeleteLocations.Set(context, new Box<Location>(locationDelete.ToList()));

    CreateContacts.Set(context, new Box<(string, ICustomer)>(
        customerCreate.Select(x => (x.Item1, x.Item2)).ToList()));
    UpdateContacts.Set(context, new Box<(string, ICustomer)>(
        customerEdit.Select(x => (x.Item1, x.Item2)).ToList()));
    DeleteContacts.Set(context, new Box<DestinoId>(customerDelete.ToList()));

    MainContactAssign.Set(context, new Box<(string, ICustomer)>(
        mainContactAssign.Select(x => (x.Item1, x.Item2)).ToList()));
    AssignRoles.Set(context, new Box<(ICustomer, ILocation)>(
        roleCreate.Select(x => (x.Item1, x.Item2)).ToList()));

    return new() { InformationLogs = [ /* ... */ ] };
}
```

**Por qué los contactos se procesan dos veces (location + company):**

En Shopify B2B un contacto puede estar asociado a la empresa en su conjunto (`company.GetCustomers()`) o a una sucursal concreta (`location.GetCustomers()`). El código los clasifica por ambas rutas para garantizar que ningún contacto quede sin rol ni sin crear. El `HashSet` de `TryAddRole` evita que el mismo par `(contacto, sucursal)` genere dos asignaciones de rol aunque se procese desde ambas rutas.

**Borrado de contactos:**

```csharp
List<DestinoId> companyContactsDelete = companyContacts
    .Where(x => customersCompany.All(y => !x.Customer.IsAgent && y.OriginId != x.OrigenId))
    .Select(x => x.DestinoId)
    .ToList();
```

Para cada company existente, se calcula `customersCompany` acumulando todos los contactos de todas sus locations más los contactos de nivel company. Luego se compara con los que hay en BD: los que están en BD pero no en `customersCompany` se borran. Los que son agentes (`IsAgent`) nunca se borran automáticamente.

---

## 4. ImageDecision — RunAsync

**Fichero:** `UPG.Pataky.Shared/Shared/Activities/Decisions/ImageDecision.cs`

Clasifica imágenes de producto en cinco operaciones: crear, actualizar, borrar, asociar a variante y desasociar de variante.

### Clasificación básica (crear / actualizar / borrar)

```csharp
var imagesDb = await transactionsService.Products.Medias.GetFromProducts(
    includeProducts: true, includeVariants: true);

var imagesDbByOriginId = imagesDb
    .GroupBy(x => x.OrigenId)
    .ToDictionary(x => x.Key, x => x.First());

var currentImageOriginIds = _images
    .Select(x => x.ImageOriginId)
    .ToHashSet();

var crear     = _images.Where(x => !imagesDbByOriginId.ContainsKey(x.ImageOriginId)).ToList();
var actualizar = _images.Where(x =>  imagesDbByOriginId.ContainsKey(x.ImageOriginId)).ToList();
var eliminar  = imagesDb
    .Where(x => !currentImageOriginIds.Contains(x.OrigenId))
    .Select(x => x.DestinoId)
    .ToList();
```

El `ImageOriginId` es la URL de la imagen. Si la URL ya existe en BD → actualizar; si no existe → crear. Las imágenes que están en BD pero cuya URL no llega del PIM → eliminar.

### AppendMedias y DetachMedias

Esta es la parte más compleja. Calcula qué asociaciones imagen-variante hay que añadir o quitar comparando el estado deseado (lo que llega del PIM) con el estado actual (lo que hay en BD).

```csharp
// Estado deseado: por variante, qué imagen debería tener
var desiredAssignmentsByVariant = _images
    .SelectMany(image => (image.ProductVariantsOriginId ?? [])
        .Where(variantOriginId => !string.IsNullOrWhiteSpace(variantOriginId))
        .Distinct()
        .Select(variantOriginId =>
            (image.ProductOriginId, VariantOriginId: variantOriginId, image.ImageOriginId)))
    .GroupBy(x => x.VariantOriginId)
    .ToDictionary(x => x.Key, x =>
    {
        var distinctImages = x.Select(y => y.ImageOriginId).Distinct().ToList();
        if (distinctImages.Count > 1)
            _logger.LogWarning(
                "La variante {variantOriginId} ha llegado asociada a varias imágenes. Se utilizará la primera.",
                x.Key, distinctImages.ToPrettyString());
        return x.First();
    });

// Estado actual: por variante, qué imagen tiene en BD
var currentAssignmentsByVariant = imagesDb
    .SelectMany(media => media.Variants.Select(variant =>
        (ProductOriginId: media.Product.OrigenId,
         VariantOriginId: variant.OrigenId,
         ImageOriginId: media.OrigenId)))
    .GroupBy(x => x.VariantOriginId)
    .ToDictionary(x => x.Key, x => x.First());
```

Ambos diccionarios mapean `VariantOriginId → (ProductOriginId, VariantOriginId, ImageOriginId)`. Luego se comparan:

```csharp
var imageOriginIdsToDelete = imagesDb
    .Where(x => !currentImageOriginIds.Contains(x.OrigenId))
    .Select(x => x.OrigenId)
    .ToHashSet();

foreach (var variantOriginId in desiredAssignmentsByVariant.Keys.Union(currentAssignmentsByVariant.Keys))
{
    desiredAssignmentsByVariant.TryGetValue(variantOriginId, out var desired);
    currentAssignmentsByVariant.TryGetValue(variantOriginId, out var current);

    if (current == default)
    {
        // Variante sin asignación actual → asociar la imagen deseada
        append.Add(desired);
        continue;
    }

    if (desired == default)
    {
        // Variante sin asignación deseada → desasociar la actual
        // (solo si la imagen no se va a borrar de todas formas)
        if (!imageOriginIdsToDelete.Contains(current.ImageOriginId))
            detach.Add(current);
        continue;
    }

    if (current.ImageOriginId == desired.ImageOriginId)
    {
        // Mismo estado → no hacer nada
        continue;
    }

    // Imagen diferente → desasociar la actual y asociar la nueva
    if (!imageOriginIdsToDelete.Contains(current.ImageOriginId))
        detach.Add(current);
    append.Add(desired);
}
```

**Por qué se comprueba `imageOriginIdsToDelete` antes de desasociar:** si una imagen ya va a borrarse, Shopify desasocia sus variantes automáticamente al borrarla. Añadir explícitamente una operación de desasociación para esa imagen provocaría un error 404.

---

## 5. PriceListDecision — RunAsync

**Fichero:** `UPG.Pataky.Shared/Shared/Activities/Decisions/PriceListDecision.cs`

El más sencillo de los cinco. Clasifica tarifas B2B en tres operaciones.

```csharp
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var transactionsService = context.GetRequiredService<TransactionsService>();

    var tarifasCrear   = new List<IPriceList>();
    var tarifasEditar  = new List<IPriceList>();
    var tarifasEliminar = new List<string>();

    var tarifasDb = await transactionsService.Products.PriceLists.Get();

    // Clasificar tarifas entrantes
    _tarifas.ForEach(tarifa => {
        var existTarifaInBd = tarifasDb.Any(x => x.OrigenId == tarifa.OriginId);
        if (!existTarifaInBd)
            tarifasCrear.Add(tarifa);
        else
            tarifasEditar.Add(tarifa);
    });

    // Detectar tarifas desaparecidas
    tarifasDb.ForEach(tarifaDb => {
        // Las tarifas de mercado (MarketCatalog) las gestiona Shopify, nunca se borran
        if (tarifaDb.CatalogId!.StartsWith("gid://shopify/MarketCatalog"))
            return;

        var existTarifa = _tarifas.Any(x => x.OriginId == tarifaDb.OrigenId);
        if (!existTarifa)
            tarifasEliminar.Add(tarifaDb.DestinoId);
    });

    PriceListsEliminar.Set(context, new Box<string>(tarifasEliminar));
    PriceListsEditar.Set(context,   new Box<IPriceList>(tarifasEditar));
    PriceListsCrear.Set(context,    new Box<IPriceList>(tarifasCrear));

    return new()
    {
        InformationLogs = [
            $"Recuperadas {tarifasCrear.Count} tarifas para crear.",
            $"Recuperadas {tarifasEditar.Count} tarifas para actualizar.",
            $"Recuperadas {tarifasEliminar.Count} tarifas para eliminar."
        ]
    };
}
```

**El caso especial de `MarketCatalog`:**

```csharp
if (tarifaDb.CatalogId!.StartsWith("gid://shopify/MarketCatalog"))
    return;
```

Shopify B2B permite dos tipos de catálogos de precio: los manuales (`CompanyCatalog`, que son los que gestiona el ERP) y los de mercado (`MarketCatalog`, que son automáticos de Shopify). Los `MarketCatalog` nunca deben borrarse desde el ETL — son catálogos de precios públicos que Shopify gestiona por su cuenta. Sin este filtro, el ETL los borraría en cada sincronización porque el ERP no los conoce.

---

## Resumen de los 5 métodos

| Decision | Estrategia de comparación | Casos especiales |
|---|---|---|
| `ProductsDecision` | Consulta individual por OriginId | — |
| `ProductsRebuildDecision` | Carga BD completa en dict, diff con Set | RebuildOptions, MaxVariants, promoción a borrado, supresión de variantes |
| `CustomerDecision` | Lookup en listas precargadas de BD | Jerarquía 3 niveles, TryAddRole con HashSet, MainContact diff, agentes excluidos de borrado |
| `ImageDecision` | Comparación por URL (ImageOriginId) | AppendMedias/DetachMedias por diff de asignaciones variante-imagen |
| `PriceListDecision` | Comparación simple por OriginId | Excluir MarketCatalog del borrado |
