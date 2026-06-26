---
tags:
  - Workflows
  - Procesos
  - Clientes
  - ERP
  - Shopify
  - B2B
---

# WF-03 — Clientes: Métodos y funciones

---

## Índice

1. [CustomerExtract — clase](#1-customerextract-clase)
2. [CustomerExtract.RunAsync](#2-customerextractrunasync)
3. [CustomerTransform — clase](#3-customertransform-clase)
4. [CustomerTransform.InitInputs](#4-customertransforminitinputs)
5. [CustomerTransform.ShouldRunAsync](#5-customertransformshouldrunasync)
6. [CustomerTransform.RunAsync — Companies](#6-customertransformrunasync-companies)
7. [CustomerTransform.RunAsync — Contacts y Locations](#7-customertransformrunasync-contacts-y-locations)
8. [CustomerTransform.RunAsync — Roles y Catálogo](#8-customertransformrunasync-roles-y-catalogo)
9. [Métodos de metafields](#9-metodos-de-metafields)

---

## 1. `CustomerExtract` — clase

**Fichero:** `Extractors/CustomerExtract.cs`
**Namespace:** `Extractors`
**Hereda de:** `BaseActivity<CustomerExtract>`

```csharp
public class CustomerExtract : BaseActivity<CustomerExtract>
{
    [Output] public required Output<Box<ICompany>> Companies { get; init; }
    ...
}
```

Sin inputs del workflow. Toda la configuración viene de `IConfiguration` y `ProvallianceService`.

---

## 2. `CustomerExtract.RunAsync`

```csharp title="CustomerExtract.cs"
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    ProvallianceService service = context.GetRequiredService<ProvallianceService>();

    var clientes = await FuncUtils.WithCachedRun(
        () => service.GetClients(),
        "tmp/debug/provalliance/middleware", "clientes", _logger); // (1)!

    if (clientes.Count == 0)
    {
        throw new Exception("La lista de clientes está vacía o no se pudo recuperar."); // (2)!
    }

    var leadPrefix = _configuration["ShopifyCredentials:LeadPrefix"].ShouldNotBeNull();
    clientes = clientes
        .Where(c => !c.OriginId.Trim().StartsWith(leadPrefix, StringComparison.OrdinalIgnoreCase))
        .ToList(); // (3)!

    foreach (var cliente in clientes)
    {
        foreach (var location in cliente.Locations)
        {
            location.LocationOriginId = cliente.OriginId + "#" + location.Codadr; // (4)!
            location.Crn = cliente.Bprc1.Crn;
        }
    }

    int totalClientes = clientes.Count;
    clientes = clientes.Where(c => !string.IsNullOrWhiteSpace(c.OriginId)).ToList(); // (5)!

    Companies.Set(context, new Box<ICompany>(clientes.Cast<ICompany>().ToList()));
    ...
}
```
1. Caché de debug: guarda la respuesta en `tmp/debug/provalliance/middleware/clientes.json`. En producción, la llamada al ERP es directa cada vez.
2. Si el ERP devuelve 0 clientes, el workflow **se cancela con excepción**. Una sincronización full-sync con 0 clientes interpretaría que todos los clientes de Shopify deben eliminarse — consecuencia inaceptable.
3. Filtra clientes "lead" (prospects) cuyo `OriginId` empieza por `LeadPrefix` (por defecto `"LEAD#"`). Los leads no se sincronizan en Shopify B2B porque no son clientes activos.
4. `LocationOriginId` se construye como `clienteOriginId + "#" + Codadr`. El carácter `#` actúa como separador inequívoco porque los OriginIds del ERP no contienen `#`. Esto garantiza que dos sucursales de clientes distintos con el mismo `Codadr` tengan `LocationOriginId` diferentes.
5. Segunda pasada de filtrado: elimina clientes con `OriginId` vacío o nulo. Estos serían inválidos en cualquier operación CRUD de Shopify.

---

## 3. `CustomerTransform` — clase

**Fichero:** `Transformers/CustomerTransform.cs`
**Namespace:** `Transformers`
**Hereda de:** `BaseActivity<CustomerTransform>`

Clase de alta complejidad con 11 inputs clasificados por `CustomerDecision` y 1 output consolidado.

```csharp
public class CustomerTransform : BaseActivity<CustomerTransform>
{
    // Companies
    [Input] public Output<Box<ICompany>> CreateCompanies { get; set; } = null;
    [Input] public Output<Box<(DestinoId, ICompany)>> UpdateCompanies { get; set; } = null;
    [Input] public Output<Box<DestinoId>> DeleteCompanies { get; set; } = null;
    // Locations
    [Input] public Output<Box<(DestinoId, ILocation)>> CreateLocations { get; set; } = null;
    [Input] public Output<Box<(DestinoId, ILocation)>> UpdateLocations { get; set; } = null;
    [Input] public Output<Box<Location>> DeleteLocations { get; set; } = null;
    // Contacts
    [Input] public Output<Box<(DestinoId, ICustomer)>> CreateContacts { get; set; } = null;
    [Input] public Output<Box<(DestinoId, ICustomer)>> UpdateContacts { get; set; } = null;
    [Input] public Output<Box<DestinoId>> DeleteContacts { get; set; } = null;
    // Assignments
    [Input] public Output<Box<(DestinoId, ICustomer)>> MainContactAssign { get; set; } = null;
    [Input] public Output<Box<(ICustomer, ILocation)>> AssignRoles { get; set; } = null;

    [Output] public required Output<CompaniesWithContactsInput> Output { get; set; } = null!;
    ...
}
```

> Los inputs usan `Output<Box<T>>` (en lugar de `Input<Box<T>>`) porque se leen desde las variables de output de `CustomerDecision`. Es el patrón de conexión de variables del workflow.

---

## 4. `CustomerTransform.InitInputs`

```csharp title="CustomerTransform.cs"
protected override void InitInputs(ActivityExecutionContext context)
{
    _createCompanies = context.Get(CreateCompanies)!.Property.ToList();
    _updateCompanies = context.Get(UpdateCompanies)!.Property.ToList();
    _deleteCompanies = context.Get(DeleteCompanies)!.Property.ToList();

    _createContacts  = context.Get(CreateContacts)!.Property.ToList();
    _updateContacts  = context.Get(UpdateContacts)!.Property.ToList();
    _deleteContacts  = context.Get(DeleteContacts)!.Property.ToList();

    _createLocations = context.Get(CreateLocations)!.Property.ToList();
    _updateLocations = context.Get(UpdateLocations)!.Property.ToList();
    _deleteLocations = context.Get(DeleteLocations)!.Property.ToList();

    _mainContactAssign = context.Get(MainContactAssign)!.Property.ToList();
    _assignRoles       = context.Get(AssignRoles)!.Property.ToList();
}
```

Materializa los 11 inputs. La operación de `context.Get(X)` lee el valor de la variable del workflow asociada al output de `CustomerDecision`.

---

## 5. `CustomerTransform.ShouldRunAsync`

```csharp title="CustomerTransform.cs"
protected override bool ShouldRunAsync() =>
    _createCompanies.Count > 0 ||
    _updateCompanies.Count > 0 ||
    _deleteCompanies.Count > 0;
```

Solo se ejecuta si hay cambios en **Companies**. Si solo cambian sucursales o contactos (sin cambios en empresas), el transformer se salta. Esto puede ser una limitación: en sincronizaciones parciales donde solo cambian sucursales o contactos, el transformer y el loader no se ejecutarán.

---

## 6. `CustomerTransform.RunAsync` — Companies

```csharp title="CustomerTransform.cs"
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var config = new MapperConfiguration(cfg =>
    {
        var logger = context.GetRequiredService<ILogger<CustomersMappingProfile>>();
        cfg.AddProfile(new CustomersMappingProfile(logger));
    });
    var mapper = config.CreateMapper(); // (1)!

    _createCompanies.ForEach(company =>
    {
        try
        {
            var companyOriginInput = new OriginInput<CompanyInput>
            {
                Input    = mapper.Map<CompanyInput>(company),
                OriginId = company.OriginId.ToString()
            };

            company.GetCustomers()?.ForEach(customer =>
            {
                try
                {
                    var contactOriginInput = new OriginInput<CompanyContactInput>
                    {
                        OriginId = customer.OriginId,
                        Input    = mapper.Map<CompanyContactInput>(customer)
                    };
                    contactOriginInput.Input.Phone = null; // (2)!
                    contactsCompany.Add(contactOriginInput);
                    metafieldSets.AddRange(GetMetafieldsCustomer((LocationResponseModel)customer));
                }
                catch (Exception ex) { _logger.LogError(...); }
            });
            ...
        }
        catch (Exception ex) { _logger.LogError(...); }
    });
```
1. `CustomersMappingProfile` contiene los mapeos de `ICompany` → `CompanyInput`, `ICustomer` → `CompanyContactInput`, `ILocation` → `CompanyLocationInput`. Se crea el mapper dentro de `RunAsync` para poder inyectar el logger en el perfil (el perfil puede registrar advertencias durante el mapeo).
2. El teléfono se establece a `null` en la **creación** de contactos. Shopify valida el formato de número de teléfono en la creación pero no en la actualización. Al omitirlo en la creación, se evitan errores de validación si el ERP almacena formatos no estándar.

---

## 7. `CustomerTransform.RunAsync` — Contacts y Locations

```csharp title="CustomerTransform.cs"
    var createContactsShopify = _createContacts
        .GroupBy(c => c.Item1)  // agrupar por DestinoId de Company (1)
        .ToDictionary(
            g => g.Key,
            g => g.Select(c =>
            {
                var input    = mapper.Map<CompanyContactInput>(c.Item2);
                input.Phone  = null;
                var originId = c.Item2.OriginId;
                var result   = new OriginInput<CompanyContactInput>
                {
                    OriginId = originId,
                    Input    = input
                };

                if (string.IsNullOrWhiteSpace(input.Email))
                {
                    _logger.LogError("El email del cliente {OriginId} no es válido... ", originId, ...);
                    return null; // (2)!
                }
                return result;
            }).DiscardNulls()
            .ToArray()
        );
```
1. Los nuevos contactos se agrupan por el `DestinoId` (ShopifyId) de su empresa. El loader crea los contactos pasando por el endpoint de cada empresa.
2. Si el email del contacto está vacío, se descarta con `LogError`. Un contacto sin email no puede registrarse en Shopify — el email es el identificador del Customer en B2B.

---

## 8. `CustomerTransform.RunAsync` — Roles y Catálogo

```csharp title="CustomerTransform.cs"
    // Catálogo por defecto para nuevas sucursales
    var defaultPriceListId = _configuration["ShopifyCredentials:DefaultPriceListId"];
    Dictionary<string, string[]> priceListUpdateCompanyLocations = [];

    if (string.IsNullOrWhiteSpace(defaultPriceListId))
    {
        _logger.LogWarning("No se ha establecido el valor de la tarifa por defecto..."); // (1)!
    }
    else if (!locationsOriginIds.IsNullOrDefault())
    {
        priceListUpdateCompanyLocations = new Dictionary<string, string[]>
        {
            { defaultPriceListId, locationsOriginIds.ToArray() } // (2)!
        };
    }

    var assignRoles = _assignRoles
        .Where(r => !string.IsNullOrWhiteSpace(r.Item1.OriginId) &&
                    !string.IsNullOrWhiteSpace(r.Item2.OriginId))
        .Select(r => (r.Item1.GetRoleOriginId(r.Item2), r.Item1.OriginId.Trim(), r.Item2.OriginId.Trim()))
        .ToList(); // (3)!
```
1. Si no se configuró `DefaultPriceListId`, se emite un aviso pero el workflow continúa. Las nuevas sucursales no tendrán tarifa asignada automáticamente — habrá que asignarla manualmente en Shopify.
2. Se prepara un mapa `{ priceListId → [locationOriginIds] }` para que el loader asigne la tarifa a todas las sucursales nuevas creadas en este ciclo.
3. `GetRoleOriginId(location)` genera un identificador compuesto para el rol (Customer + Location). Los roles cuyo Customer u Location tengan OriginId vacío se filtran antes de procesar.

---

## 9. Métodos de metafields

```csharp title="CustomerTransform.cs"
private List<MetafieldSet> GetMetafieldsCompany(ClientResponseModel company)
{
    return new List<MetafieldSet>
    {
        new MetafieldSet
        {
            OrigenIdEntidad = ((ICompany)company).OriginId,
            MetafieldsSetInput = new MetafieldsSetInput
            {
                Key       = "zona_fiscal",   // (1)!
                Namespace = "upng",
                Type      = MetafieldTypeNum.SingleLineTextField,
                Value     = company.ZonaFiscal.zonaFiscal
            },
            Type = MetafieldOwnerType.COMPANY
        }
    };
}

private List<MetafieldSet> GetMetafieldsCustomer(LocationResponseModel customer)
{
    return new List<MetafieldSet>
    {
        new MetafieldSet
        {
            OrigenIdEntidad = ((ICustomer)customer).OriginId,
            Type            = MetafieldOwnerType.CUSTOMER,
            MetafieldsSetInput = new MetafieldsSetInput
            {
                Key       = "external_id",   // (2)!
                Namespace = "upng",
                Type      = MetafieldTypeNum.SingleLineTextField,
                Value     = ((ICustomer)customer).OriginId
            }
        }
    };
}

private List<MetafieldSet> GetMetafieldsLocation(LocationResponseModel location)
{
    return new List<MetafieldSet>(); // (3)!
}
```
1. `upng.zona_fiscal` almacena la zona fiscal del cliente ERP en el metafield de la Company de Shopify. Permite que las reglas fiscales del ERP sean visibles desde Shopify.
2. `upng.external_id` almacena el OriginId del contacto en el metafield del Customer de Shopify. Es el vínculo que permite recuperar el `CustomerId` al transformar pedidos en `OrderTransform`.
3. Las sucursales (`CompanyLocation`) no tienen metafields configurados actualmente. El método devuelve una lista vacía — es un placeholder para futuras necesidades.
