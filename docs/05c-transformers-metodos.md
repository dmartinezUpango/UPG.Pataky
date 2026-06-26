---
tags:
  - Transformers
  - Shopify
  - AutoMapper
---

# 05c — Transformers: métodos y funciones en detalle

Este documento explica paso a paso **cada método y función** que interviene en la capa de transformación. Cuando en [`05-transformers.md`](05-transformers.md) o [`05b-transformers-detalle.md`](05b-transformers-detalle.md) se mencione un método concreto, puedes venir aquí y leer su código completo con una explicación de lo que hace.

---

## Índice

1. [Actividad base — referencia](#1-actividad-base-referencia)
2. [CustomersMappingProfile — mapeos AutoMapper](#2-customersmappingprofile-mapeos-automapper)
3. [BuildAddress — conversión de dirección](#3-buildaddress-conversion-de-direccion)
4. [ZoneCodes.TryGetZoneCode — tabla de provincias ISO](#4-zonecodestrygetzonecode-tabla-de-provincias-iso)
5. [CustomerTransform — RunAsync](#5-customertransform-runasync)
6. [CustomerTransform — métodos de metafields](#6-customertransform-metodos-de-metafields)
7. [ICustomer.GetRoleOriginId](#7-icustomergetroleoriginid)
8. [OrdersMappingProfile — mapeos AutoMapper](#8-ordersmappingprofile-mapeos-automapper)
9. [OrdersMappingProfile — campos del pedido](#9-ordersmappingprofile-campos-del-pedido)
10. [OrdersMappingProfile — lógica de descuentos](#10-ordersmappingprofile-logica-de-descuentos)
11. [OrdersMappingProfile — IsDropshipping y normalización](#11-ordersmappingprofile-isdropshipping-y-normalizacion)
12. [ProductosMappingTransforms — mapeos AutoMapper](#12-productosmappingtransforms-mapeos-automapper)
13. [ProductosMappingTransforms — GetMetafieldsProducto](#13-productosmappingtransforms-getmetafieldsproducto)
14. [ProductosMappingTransforms — GetMetafieldsVariante](#14-productosmappingtransforms-getmetafieldsvariante)
15. [ProductosMappingTransforms — helpers de producto](#15-productosmappingtransforms-helpers-de-producto)
16. [ProductosMappingTransforms — helpers de tipos](#16-productosmappingtransforms-helpers-de-tipos)
17. [ProductosMappingTransforms — helpers de variante](#17-productosmappingtransforms-helpers-de-variante)

---

## 1. Actividad base — referencia

Los transformers `CustomerTransform` y `OrderTransform` heredan de `BaseActivity<T>`, igual que los extractors. Los métodos `InitInputs`, `ShouldRunAsync` y `RunAsync` tienen el mismo contrato explicado en [`04c — sección 1`](04c-extractors-metodos.md#1-infraestructura-base-de-una-actividad).

La única diferencia es que la mayoría de transformers no tienen `ShouldRunAsync() => true` fijo: algunos comprueban si hay elementos que procesar antes de ejecutarse:

```csharp
// CustomerTransform: solo corre si hay alguna operación de company
protected override bool ShouldRunAsync()
    => _createCompanies.Count > 0 || _updateCompanies.Count > 0 || _deleteCompanies.Count > 0;

// OrderTransform: solo corre si llegaron pedidos
protected override bool ShouldRunAsync() => _input.Count > 0;
```

---

## 2. CustomersMappingProfile — mapeos AutoMapper

**Fichero:** `Transformers/Mapper/CustomersMappingProfile.cs`

Este perfil de AutoMapper define cómo convertir los modelos del ERP (`ClientResponseModel`, `LocationResponseModel`) a los inputs de la API de Shopify B2B. Se instancia en `CustomerTransform.RunAsync` pasándole el `ILogger`.

### `CreateMap<ClientResponseModel, CompanyInput>`

```csharp
CreateMap<ClientResponseModel, CompanyInput>()
    .ForMember(dest => dest.ExternalId, opt => opt.MapFrom(src => src.Company.CodCom))
    .ForMember(dest => dest.Name,       opt => opt.MapFrom(src => src.Company.Name));
```

Solo dos campos directos. El `ExternalId` es el campo clave: Shopify lo almacena y el workflow de pedidos lo usa para identificar de qué cliente del ERP viene cada pedido.

### `CreateMap<LocationResponseModel, CompanyContactInput>`

```csharp
CreateMap<LocationResponseModel, CompanyContactInput>()
    .ForMember(dest => dest.Email, opt => opt.MapFrom(src => src.Email))
    .ForMember(dest => dest.Phone, opt => opt.MapFrom(src =>
        string.IsNullOrWhiteSpace(src.Phone) ? null : src.Phone));
```

El email ya viene normalizado (trim + lowercase) desde el setter de `LocationResponseModel`. El teléfono se convierte a `null` si está vacío — Shopify rechaza strings vacíos en campos de teléfono.

> En la creación de contactos, `CustomerTransform.RunAsync` pone explícitamente `input.Phone = null` después del mapeo. En la actualización, convierte el string vacío a `null` también.

### `CreateMap<LocationResponseModel, CompanyLocationInput>`

```csharp
CreateMap<LocationResponseModel, CompanyLocationInput>()
    .ForMember(dest => dest.ExternalId,        opt => opt.MapFrom(src => ((ILocation)src).OriginId))
    .ForMember(dest => dest.Name,              opt => opt.MapFrom(src => src.Contact))
    .ForMember(dest => dest.TaxRegistrationId, opt => opt.MapFrom(src => src.Crn))
    .ForPath(dest  => dest.ShippingAddress,    opt => opt.MapFrom(src => BuildAddress(logger, src)))
    .ForPath(dest  => dest.BillingAddress,     opt => opt.MapFrom(src => BuildAddress(logger, src)));
```

`((ILocation)src).OriginId` hace el cast explícito a `ILocation` para obtener el `LocationOriginId` (`{CodCliente}#{CodDireccion}`), no el `Email`. La misma dirección postal se asigna a `ShippingAddress` y `BillingAddress`: en Shopify B2B se usan los dos, pero en el ERP solo hay una dirección por sucursal.

### `CreateMap<LocationResponseModel, CompanyLocationUpdateInput>`

```csharp
CreateMap<LocationResponseModel, CompanyLocationUpdateInput>()
    .ForMember(dest => dest.ExternalId, opt => opt.MapFrom(src => ((ILocation)src).OriginId))
    .ForMember(dest => dest.Name,       opt => opt.MapFrom(src => src.Contact))
    .ForMember(dest => dest.Phone,      opt => opt.MapFrom(src =>
        string.IsNullOrWhiteSpace(src.Phone) ? null : src.Phone))
    .ForMember(dest => dest.BuyerExperienceConfiguration, opt => opt.MapFrom(src =>
        new BuyerExperienceConfigurationInput
        {
            EditableShippingAddress = true
        }));
```

Para la actualización se añaden dos campos que no existen en el input de creación: `Phone` (en creación se pone a null expresamente para no bloquear la operación) y `BuyerExperienceConfiguration.EditableShippingAddress = true` (permite al cliente B2B modificar su dirección de envío al hacer un pedido).

---

## 3. BuildAddress — conversión de dirección

**Fichero:** `Transformers/Mapper/CustomersMappingProfile.cs`
**Firma:** `static CompanyAddressInput BuildAddress(ILogger logger, LocationResponseModel location)`

Convierte una dirección del ERP al formato `CompanyAddressInput` que requiere la API de Shopify. El reto es que el ERP usa códigos de provincia en formato interno (Sage X3) y Shopify exige el estándar ISO 3166-2.

```csharp
public static CompanyAddressInput BuildAddress(ILogger logger, LocationResponseModel location)
{
    CountryCode? countryCode;
    string? zoneCode;

    if (Enum.TryParse<CountryCode>(location.Country, out var value))
    {
        countryCode = value;
        zoneCode = string.IsNullOrWhiteSpace(location.ZoneCode)
            ? null
            : ZoneCodes.TryGetZoneCode(countryCode.ToString()!, location.ZoneCode);
    }
    else
    {
        logger.LogError(
            "No se pudo parsear valor de {nameof} a un valor válido del enumerado {enum}: {valor}",
            nameof(LocationResponseModel.Country), nameof(CountryCode), location.Country);
        countryCode = null;
        zoneCode    = null;
    }

    if (zoneCode is null && !string.IsNullOrWhiteSpace(location.ZoneCode))
    {
        logger.LogError(
            "No se encontró un valor de ZoneCode que se ajuste al valor de origen: {zonecode} ({country}) para la location {id}.",
            location.ZoneCode, location.Country, location.LocationOriginId);
    }

    return new CompanyAddressInput
    {
        Address1    = location.Address1,
        Address2    = location.Address2,
        City        = location.City,
        Zip         = location.Zip,
        Recipient   = location.Contact,
        Phone       = string.IsNullOrWhiteSpace(location.Phone) ? null : location.Phone,
        ZoneCode    = zoneCode,
        CountryCode = countryCode
    };
}
```

**Flujo paso a paso:**

```text
location.Country (ej: "ES")
    │
    ▼
Enum.TryParse<CountryCode>("ES")
    │
    ├── OK → countryCode = CountryCode.ES
    │         ↓
    │         ZoneCodes.TryGetZoneCode("ES", location.ZoneCode)
    │              ej: "MAD" → "ES-MD"
    │              ej: "BURGOS" → "ES-BU"
    │              ej: valor desconocido → null + LogError
    │
    └── FAIL → LogError + countryCode = null + zoneCode = null
               (la dirección se sube sin código de país ni provincia)
```

Si `ZoneCode` no se puede traducir, se loguea error pero la operación continúa — Shopify acepta una dirección sin `ZoneCode`, aunque no es ideal.

---

## 4. ZoneCodes.TryGetZoneCode — tabla de provincias ISO

**Proyecto:** `UPG.SharedUtils` (proyecto compartido)
**Fichero:** `UPG.SharedUtils/Utils/ISO/ZoneCodes.cs`

Esta utilidad carga una tabla CSV (`zone_codes.csv`) y expone dos métodos de búsqueda. El CSV tiene tres columnas: `country`, `province`, `zone_code`.

### `TryGetZoneCode(string country, string province)`

```csharp
public static string? TryGetZoneCode(string country, string province)
{
    if (string.IsNullOrWhiteSpace(country) || string.IsNullOrWhiteSpace(province))
        return null;

    var key = (NormalizeCode(country), NormalizeProvince(province));
    return Lookup.Value.ZoneCodesByProvince.GetValueOrDefault(key);
}
```

Busca en el diccionario `ZoneCodesByProvince` por la clave `(país, provincia)`. Si no encuentra la combinación, devuelve `null`.

### `TryGetProvince(string country, string zoneCode)`

```csharp
public static string? TryGetProvince(string country, string zoneCode)
{
    if (string.IsNullOrWhiteSpace(country) || string.IsNullOrWhiteSpace(zoneCode))
        return null;

    var key = (NormalizeCode(country), NormalizeCode(zoneCode));
    return Lookup.Value.ProvincesByZoneCode.GetValueOrDefault(key);
}
```

La búsqueda inversa: dado un código de zona, devuelve el nombre de la provincia.

### Normalización para la búsqueda

La clave del mapa se normaliza antes de la búsqueda para hacer las comparaciones insensibles a acentos, mayúsculas y espacios extra:

```csharp
private static string NormalizeCode(string code)
    => code.Trim().ToUpperInvariant();

private static string NormalizeProvince(string province)
{
    if (string.IsNullOrWhiteSpace(province))
        return string.Empty;

    // 1. Descomponer caracteres acentuados: "Álava" → "Álava"
    var decomposed = province.Trim().ToLowerInvariant().Normalize(NormalizationForm.FormD);
    var normalized = new StringBuilder(decomposed.Length);

    // 2. Eliminar las marcas diacríticas (acentos, tildes, etc.)
    foreach (var character in decomposed)
    {
        if (CharUnicodeInfo.GetUnicodeCategory(character) != UnicodeCategory.NonSpacingMark)
            normalized.Append(character);
    }

    // 3. Recomponer y colapsar espacios múltiples
    var withoutDiacritics = normalized.ToString().Normalize(NormalizationForm.FormC);
    return string.Join(' ', withoutDiacritics.Split(' ', StringSplitOptions.RemoveEmptyEntries));
}
```

Esto permite que `"BURGOS"`, `"Burgos"` y `"burgos"` encuentren el mismo resultado.

### Carga perezosa del CSV

```csharp
private static readonly Lazy<ZoneCodeLookup> Lookup = new(LoadLookup);
```

El CSV solo se lee una vez, la primera vez que se consulta (`Lazy<T>`). Después queda en memoria para toda la vida del proceso.

---

## 5. CustomerTransform — RunAsync

**Fichero:** `Transformers/CustomerTransform.cs`

El método más complejo de la capa de transformación. Procesa ocho tipos de operación en una sola pasada (crear/actualizar/borrar companies, locations y contacts, más asignación de roles y contacto principal).

```csharp
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var config = new MapperConfiguration(cfg =>
    {
        var logger = context.GetRequiredService<ILogger<CustomersMappingProfile>>();
        cfg.AddProfile(new CustomersMappingProfile(logger));
    });
    var mapper = config.CreateMapper();

    var createCompaniesShopify =
        new Dictionary<OriginInput<CompanyInput>,
            (OriginInput<CompanyContactInput>[]? Contacts,
             OriginInput<CompanyLocationInput>[] Locations)>();
    List<(string, CompanyInput)> updateCompaniesShopify = [];
    Dictionary<string, (CompanyAddressType, CompanyAddressInput)[]> updateLocationsAddresses = [];
    List<MetafieldSet> metafieldSets = new List<MetafieldSet>();
    Dictionary<string, ISet<string>>? addCustomersTags = [];

    // OriginIds de locations nuevas que recibirán el catálogo por defecto
    var locationsOriginIds = new List<string>();

    // ── CREAR companies ──────────────────────────────────────────────────
    _createCompanies.ForEach(company =>
    {
        try
        {
            var contactsCompany  = new List<OriginInput<CompanyContactInput>>();
            var locationsCompany = new List<OriginInput<CompanyLocationInput>>();

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
                    contactOriginInput.Input.Phone = null;  // se omite en creación
                    contactsCompany.Add(contactOriginInput);
                    metafieldSets.AddRange(GetMetafieldsCustomer((LocationResponseModel)customer));
                }
                catch (Exception ex)
                {
                    _logger.LogError(
                        $"Ha fallado la transformación del customer {customer.OriginId} " +
                        $"de la company {company.OriginId}.\nMessage: {ex.Message}");
                }
            });

            company.GetLocations()?.ForEach(location =>
            {
                try
                {
                    var locationOriginInput = new OriginInput<CompanyLocationInput>
                    {
                        OriginId = location.OriginId,
                        Input    = mapper.Map<CompanyLocationInput>((LocationResponseModel)location)
                    };
                    // Teléfonos a null en creación
                    locationOriginInput.Input.Phone = null;
                    locationOriginInput.Input.ShippingAddress!.Phone = null;
                    locationOriginInput.Input.BillingAddress!.Phone  = null;
                    locationsCompany.Add(locationOriginInput);
                    metafieldSets.AddRange(GetMetafieldsLocation((LocationResponseModel)location));
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex,
                        "Ha fallado la transformación de la location {id} de la company {cid}.",
                        location.OriginId, company.OriginId);
                }
            });

            locationsOriginIds.AddRange(locationsCompany.Select(l => l.OriginId));
            createCompaniesShopify.Add(companyOriginInput,
                (contactsCompany.ToArray(), locationsCompany.ToArray()));
            metafieldSets.AddRange(GetMetafieldsCompany((ClientResponseModel)company));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Ha fallado la transformación de la company {id}.", company.OriginId);
        }
    });

    // ── ACTUALIZAR companies ─────────────────────────────────────────────
    _updateCompanies.ForEach(company =>
    {
        try
        {
            updateCompaniesShopify.Add((company.Item1, mapper.Map<CompanyInput>(company.Item2)));
            metafieldSets.AddRange(GetMetafieldsCompany((ClientResponseModel)company.Item2));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error al transformar la company {ref} para actualizar.", company.Item2);
        }
    });

    // ── CREAR contacts ───────────────────────────────────────────────────
    var createContactsShopify = _createContacts
        .GroupBy(c => c.Item1)
        .ToDictionary(
            g => g.Key,
            g => g.Select(c =>
            {
                metafieldSets.AddRange(GetMetafieldsCustomer((LocationResponseModel)c.Item2));
                var input    = mapper.Map<CompanyContactInput>(c.Item2);
                input.Phone  = null;
                var originId = c.Item2.OriginId;
                var result   = new OriginInput<CompanyContactInput> { OriginId = originId, Input = input };

                if (string.IsNullOrWhiteSpace(input.Email))
                {
                    _logger.LogError(
                        "El email del cliente {OriginId} no es válido, con el valor: {Email}.",
                        originId, result.Input.Email?.WithQuotes());
                    return null;
                }
                return result;
            }).DiscardNulls().ToArray()
        );

    // ── ACTUALIZAR contacts ──────────────────────────────────────────────
    var updateContactsShopify = _updateContacts.Select(x =>
    {
        var input = mapper.Map<CompanyContactInput>(x.Item2);
        if (string.IsNullOrWhiteSpace(input.Phone)) input.Phone = null;
        metafieldSets.AddRange(GetMetafieldsCustomer((LocationResponseModel)x.Item2));
        return (x.Item1, mapper.Map<CompanyContactInput>(x.Item2));
    }).ToList();

    // ── CREAR locations ──────────────────────────────────────────────────
    var createLocationsShopify = _createLocations
        .GroupBy(x => x.Item1)
        .ToDictionary(
            g => g.Key,
            g => g.Select(x =>
            {
                metafieldSets.AddRange(GetMetafieldsLocation((LocationResponseModel)x.Item2));
                var input = mapper.Map<CompanyLocationInput>(x.Item2);
                input.Phone = null;
                input.ShippingAddress!.Phone = null;
                input.BillingAddress!.Phone  = null;
                return new OriginInput<CompanyLocationInput>
                {
                    OriginId = x.Item2.OriginId,
                    Input    = input
                };
            }).ToArray()
        );

    // ── ACTUALIZAR locations ─────────────────────────────────────────────
    var updateLocationsShopify = _updateLocations
        .Select(x =>
        {
            metafieldSets.AddRange(GetMetafieldsLocation((LocationResponseModel)x.Item2));
            var address = CustomersMappingProfile.BuildAddress(_logger, (LocationResponseModel)x.Item2);
            updateLocationsAddresses[x.Item1] = new[]
            {
                (CompanyAddressType.SHIPPING, address),
                (CompanyAddressType.BILLING,  address)
            };
            var input = mapper.Map<CompanyLocationUpdateInput>(x.Item2);
            if (string.IsNullOrWhiteSpace(input.Phone)) input.Phone = "";
            return (x.Item1, mapper.Map<CompanyLocationUpdateInput>(x.Item2));
        }).ToList();

    // ── Catálogo por defecto para locations nuevas ───────────────────────
    var defaultPriceListId = _configuration["ShopifyCredentials:DefaultPriceListId"];
    Dictionary<string, string[]> priceListUpdateCompanyLocations = [];
    if (string.IsNullOrWhiteSpace(defaultPriceListId))
    {
        _logger.LogWarning("No se ha establecido el valor de la tarifa por defecto, se omitirá esta lógica.");
    }
    else if (!locationsOriginIds.IsNullOrDefault())
    {
        priceListUpdateCompanyLocations = new Dictionary<string, string[]>
        {
            { defaultPriceListId, locationsOriginIds.ToArray() }
        };
    }

    // ── AssignRoles ──────────────────────────────────────────────────────
    var assignRoles = _assignRoles
        .Where(r => !string.IsNullOrWhiteSpace(r.Item1.OriginId)
                 && !string.IsNullOrWhiteSpace(r.Item2.OriginId))
        .Select(r => (r.Item1.GetRoleOriginId(r.Item2),
                      r.Item1.OriginId.Trim(),
                      r.Item2.OriginId.Trim()))
        .ToList();

    // ── MainContacts ─────────────────────────────────────────────────────
    var mainContactsToAssign = _mainContactAssign
        .Where(x => !string.IsNullOrWhiteSpace(x.Item1)
                 && !string.IsNullOrWhiteSpace(x.Item2.OriginId))
        .Select(x => (x.Item1, x.Item2.OriginId.Trim()))
        .ToArray();

    Output.Set(context, new CompaniesWithContactsInput
    {
        CreateCompanies             = createCompaniesShopify,
        UpdateCompanies             = updateCompaniesShopify.ToArray(),
        DeleteCompanies             = _deleteCompanies.ToArray(),
        CreateContacts              = createContactsShopify,
        UpdateContacts              = updateContactsShopify.ToArray(),
        DeleteContacts              = _deleteContacts.Distinct().ToArray(),
        CreateLocations             = createLocationsShopify,
        UpdateLocations             = updateLocationsShopify.ToArray(),
        UpdateLocationAddresses     = updateLocationsAddresses,
        DeleteLocations             = _deleteLocations.Select(x => x.DestinoId).Distinct().ToArray(),
        AssignRoles                 = assignRoles.ToArray(),
        MainContactsToAssign        = mainContactsToAssign,
        MarketsAndPriceListsToUpdate = priceListUpdateCompanyLocations,
        MarketsAndPriceListsRemoveMissingLocations = false,
        AddCustomersTags            = addCustomersTags,
        CreateMetafields            = metafieldSets.ToArray(),
    });

    return new()
    {
        InformationLogs =
        [
            $"Se van a crear {createCompaniesShopify.Count} Companies en Shopify.",
            $"Se van a actualizar {updateCompaniesShopify.Count} Companies en Shopify.",
            $"Se van a eliminar {_deleteCompanies.Count} Companies en Shopify.",
            $"Se van a crear {createContactsShopify.Count} Contactos de Companies en Shopify.",
            $"Se van a actualizar {_updateContacts.Count} Contactos de Companies en Shopify.",
            $"Se van a eliminar {_deleteContacts.Count} Contactos de Companies en Shopify.",
            $"Se van a crear {createLocationsShopify.Count} Locations de Companies en Shopify.",
            $"Se van a actualizar {updateLocationsShopify.Count} Locations de Companies en Shopify.",
            $"Se van a eliminar {_deleteLocations.Count} Locations de Companies en Shopify.",
            $"Se van a asignar {_mainContactAssign.Count} MainContacts a Companies en Shopify.",
            $"Se van a crear {metafieldSets.Count(x => x.Type == MetafieldOwnerType.COMPANY)} metafields para Companies.",
            $"Se van a crear {metafieldSets.Count(x => x.Type == MetafieldOwnerType.COMPANY_LOCATION)} metafields para sucursales.",
            $"Se van a crear {metafieldSets.Count(x => x.Type == MetafieldOwnerType.CUSTOMER)} metafields para Customers."
        ]
    };
}
```

**Resumen de las 8 operaciones que procesa en una pasada:**

| Operación | Variable resultado | Destino en el output |
|---|---|---|
| Crear companies + contacts + locations | `createCompaniesShopify` | `CreateCompanies` |
| Actualizar companies | `updateCompaniesShopify` | `UpdateCompanies` |
| Eliminar companies | `_deleteCompanies` (directo) | `DeleteCompanies` |
| Crear contacts | `createContactsShopify` | `CreateContacts` |
| Actualizar contacts | `updateContactsShopify` | `UpdateContacts` |
| Crear locations | `createLocationsShopify` | `CreateLocations` |
| Actualizar locations + sus direcciones | `updateLocationsShopify` + `updateLocationsAddresses` | `UpdateLocations` + `UpdateLocationAddresses` |
| Asignar roles | `assignRoles` | `AssignRoles` |

---

## 6. CustomerTransform — métodos de metafields

**Fichero:** `Transformers/CustomerTransform.cs`

Estos tres métodos privados construyen los `MetafieldSet` que se envían junto con las operaciones de creación/actualización.

### `GetMetafieldsCompany(ClientResponseModel company)`

```csharp
private List<MetafieldSet> GetMetafieldsCompany(ClientResponseModel company)
{
    List<MetafieldSet> toCreate = new List<MetafieldSet>();

    toCreate.Add(new MetafieldSet()
    {
        OrigenIdEntidad = ((ICompany)company).OriginId,
        MetafieldsSetInput = new MetafieldsSetInput()
        {
            Key       = "zona_fiscal",
            Namespace = "upng",
            Type      = MetafieldTypeNum.SingleLineTextField,
            Value     = company.ZonaFiscal.zonaFiscal
        },
        Type = MetafieldOwnerType.COMPANY
    });

    return toCreate;
}
```

Genera un único metafield por empresa: `upng.zona_fiscal`. Su valor es el código del campo `VACBPR` del ERP (ej: `"EXE"`, `"es_re:REQ"`). El loader de clientes lo usará para actualizar el metafield de la `Company` en Shopify.

### `GetMetafieldsLocation(LocationResponseModel location)`

```csharp
private List<MetafieldSet> GetMetafieldsLocation(LocationResponseModel location)
{
    List<MetafieldSet> toCreate = new List<MetafieldSet>();
    return toCreate;  // sin metafields de location actualmente
}
```

Actualmente devuelve siempre una lista vacía. El método existe como punto de extensión — si en el futuro se necesita añadir metafields a las sucursales, se añade aquí sin modificar el flujo general.

### `GetMetafieldsCustomer(LocationResponseModel customer)`

```csharp
private List<MetafieldSet> GetMetafieldsCustomer(LocationResponseModel customer)
{
    List<MetafieldSet> toCreate = new List<MetafieldSet>();

    toCreate.Add(new MetafieldSet()
    {
        OrigenIdEntidad = ((ICustomer)customer).OriginId,
        Type            = MetafieldOwnerType.CUSTOMER,
        MetafieldsSetInput = new MetafieldsSetInput
        {
            Key       = "external_id",
            Namespace = "upng",
            Type      = MetafieldTypeNum.SingleLineTextField,
            Value     = ((ICustomer)customer).OriginId  // = el email del contacto
        }
    });
    return toCreate;
}
```

Genera el metafield `upng.external_id` para cada contacto (Customer). Su valor es el email del contacto (el `ICustomer.OriginId`). Este metafield es el que usa el workflow de pedidos para identificar qué contacto de Shopify hizo el pedido.

---

## 7. ICustomer.GetRoleOriginId

**Fichero:** `ElsaShared/Interfaces/ICustomer.cs` (proyecto compartido `UPG.Pataky.Shared`)

Método por defecto de la interfaz `ICustomer`. Genera el identificador único de la asignación de un contacto a una sucursal (rol en Shopify B2B).

```csharp
public interface ICustomer
{
    string OriginId { get; }

    string GetRoleOriginId(ILocation location)
    {
        return $"{location.OriginId}-{OriginId}";
    }
}
```

Ejemplo: si el email del contacto es `"contacto@peluqueria.com"` y la sucursal tiene `OriginId = "C0001#DIR01"`, el rol tendrá `OriginId = "C0001#DIR01-contacto@peluqueria.com"`.

Este OriginId se guarda en la BD de transacciones para que el loader de clientes pueda comprobar si la asignación ya existe y evitar duplicarla.

---

## 8. OrdersMappingProfile — mapeos AutoMapper

**Fichero:** `Transformers/Mapper/OrdersMappingProfile.cs`

Define los dos mapeos para la transformación de pedidos. Se instancia en `OrderTransform.RunAsync` sin parámetros.

### `CreateMap<Order, OrderHeaderModel>`

```csharp
CreateMap<Order, OrderHeaderModel>()
    .ForMember(dest => dest.Id,                   opt => opt.MapFrom(src => GetOrderId(src)))
    .ForMember(dest => dest.ShopifyId,            opt => opt.MapFrom(src => GetOrderSfId(src)))
    .ForMember(dest => dest.CreatedAt,            opt => opt.MapFrom(src => FormatDateTime(src.CreatedAt)))
    .ForMember(dest => dest.EjercicioDocumento,   opt => opt.MapFrom(src => GetOrderYear(src)))
    .ForMember(dest => dest.ShippingAddressId,    opt => opt.MapFrom(src => GetLocationId(src)))
    .ForMember(dest => dest.PaymentTerms,         opt => opt.MapFrom(src => GetPaymentTermsCode(src)))
    .ForMember(dest => dest.ShippingLineCode,     opt => opt.MapFrom(src => GetShippingLineCode(src)))
    .ForMember(dest => dest.ShippingLinePrice,    opt => opt.MapFrom(src => GetShippingLinePrice(src)))
    .ForMember(dest => dest.SubtotalPrice,        opt => opt.MapFrom(src => GetSubtotalPrice(src)))
    .ForMember(dest => dest.TaxLine,              opt => opt.MapFrom(src => GetTaxLinePrice(src)))
    .ForMember(dest => dest.TotalPrice,           opt => opt.MapFrom(src => GetTotalPrice(src)))
    .ForMember(dest => dest.TotalDiscount,        opt => opt.Ignore())
    .ForMember(dest => dest.TotalDiscountPrcnt,   opt => opt.Ignore())
    .ForMember(dest => dest.Note,                 opt => opt.MapFrom(src => src.Note))
    .ForMember(dest => dest.PoNumber,             opt => opt.MapFrom(src => src.PoNumber))
    .ForMember(dest => dest.ShippingAddress,      opt => opt.MapFrom(src => GetShippingAddressIfDropshipping(src)))
    .ForMember(dest => dest.LineasDocumento,      opt => opt.Ignore())
    .AfterMap((src, dest) => SetHeaderDiscountFields(src, dest));
```

`TotalDiscount`, `TotalDiscountPrcnt` y `LineasDocumento` se ignoran en el mapeo declarativo y se rellenan mediante `AfterMap` y asignación directa en `OrderTransform.RunAsync`.

### `CreateMap<LineItem, OrderLineModel>`

```csharp
CreateMap<LineItem, OrderLineModel>()
    .ForMember(dest => dest.Price,             opt => opt.MapFrom(src => GetLinePrice(src)))
    .ForMember(dest => dest.Quantity,          opt => opt.MapFrom(src => src.Quantity))
    .ForMember(dest => dest.ProductId,         opt => opt.MapFrom(src => GetProductId(src)))
    .ForMember(dest => dest.Title,             opt => opt.MapFrom(src => GetLineTitle(src)))
    .ForMember(dest => dest.TotalDiscount,     opt => opt.Ignore())
    .ForMember(dest => dest.TotalDiscountPrcnt, opt => opt.Ignore())
    .ForMember(dest => dest.TotalPrice,        opt => opt.MapFrom(src => GetLineTotal(src)))
    .AfterMap((src, dest) => SetLineDiscountFields(src, dest));
```

---

## 9. OrdersMappingProfile — campos del pedido

**Fichero:** `Transformers/Mapper/OrdersMappingProfile.cs`

Métodos privados que extraen campos individuales de un `Order` de Shopify.

### `GetOrderId(Order source)` y `GetOrderSfId(Order source)`

```csharp
private static string GetOrderId(Order source)   => source.Name;
private static string GetOrderSfId(Order source) => source.Id!;
```

`Name` es el número legible (`"#SS4185"`) que se convierte en el ID del documento en el ERP. `Id` es el ID de GraphQL completo (`"gid://shopify/Order/123456"`).

### `GetOrderYear(Order source)`

```csharp
private static int GetOrderYear(Order source)
    => source.CreatedAt.HasValue ? source.CreatedAt.Value.Year : 0;
```

El ERP usa el año fiscal (`EjercicioDocumento`) como campo separado. Si el pedido no tiene fecha de creación (caso extraño), se devuelve 0.

### `GetLocationId(Order source)` y `NormalizeShippingAddressId(string? rawValue)`

```csharp
private static string? GetLocationId(Order source)
    => NormalizeShippingAddressId(GetPurchasingCompany(source)?.Location.ExternalId);

private static string? NormalizeShippingAddressId(string? rawValue)
{
    if (string.IsNullOrWhiteSpace(rawValue))
        return rawValue;

    var separatorIndex = rawValue.IndexOf('#');
    if (separatorIndex < 0)
        return rawValue;

    return rawValue[(separatorIndex + 1)..];
}
```

El `ExternalId` de la `Location` en Shopify tiene el formato `"{CodCom}#{CodAdr}"` (igual que el `LocationOriginId`). El ERP solo necesita el `CodAdr`, así que se extrae la parte después del `#`. Si no hay `#`, se devuelve el valor completo.

### `GetPaymentTermsCode(Order order)`

```csharp
private static string? GetPaymentTermsCode(Order order)
{
    if (order.PaymentGatewayNames is null || order.PaymentGatewayNames.Count == 0)
        return null;

    var paymentGatewayNames = order.PaymentGatewayNames
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .ToArray();

    return paymentGatewayNames.Length == 0
        ? null
        : string.Join(", ", paymentGatewayNames);
}
```

Shopify puede devolver varios métodos de pago por pedido. El ERP espera un único string, así que se unen con coma. Si no hay métodos de pago, devuelve `null`.

### `GetShippingLineCode(Order source)`

```csharp
private static string? GetShippingLineCode(Order source)
    => source.ShippingLines?.Nodes?.FirstOrDefault()?.Code;
```

Código de la primera línea de envío. Solo se procesa la primera porque en Shopify B2B los pedidos tienen una sola tarifa de envío activa.

### `FormatDateTime(DateTime? value)`

```csharp
private static string? FormatDateTime(DateTime? value)
    => value?.ToString("yyyy-MM-ddTHH:mm:ssK");
```

Convierte la fecha de creación al formato ISO 8601 con zona horaria que espera el ERP.

### `GetSubtotalPrice`, `GetTaxLinePrice`, `GetTotalPrice`

```csharp
private static decimal GetSubtotalPrice(Order source)
    => source.SubtotalPriceSet?.ShopMoney?.Amount
       ?? source.CurrentSubtotalPriceSet?.ShopMoney?.Amount
       ?? 0m;

private static decimal GetTaxLinePrice(Order source)
{
    var tax = source.TotalTaxSet?.ShopMoney?.Amount
           ?? source.CurrentTotalTaxSet?.ShopMoney?.Amount;
    if (tax.HasValue) return tax.Value;

    return source.TaxLines?.Sum(x => x.PriceSet?.ShopMoney?.Amount ?? 0m) ?? 0m;
}

private static decimal GetTotalPrice(Order source)
    => source.TotalPriceSet?.ShopMoney?.Amount
       ?? source.CurrentTotalPriceSet?.ShopMoney?.Amount
       ?? 0m;
```

El patrón es el mismo: se intenta leer el campo `*PriceSet` (importe original) y si no existe se lee el `Current*PriceSet` (importe con posibles modificaciones posteriores). El sufijo `ShopMoney` indica que se usa la moneda de la tienda (no la del cliente). Los impuestos se calculan de dos formas porque algunos pedidos vienen con `TotalTaxSet` y otros con líneas de impuesto individuales.

### `GetShippingLinePrice(Order source)`

```csharp
private static decimal? GetShippingLinePrice(Order source)
{
    if (source.ShippingLines?.Nodes is { Count: > 0 })
        return source.GetDeliveryCost(includeTax: false, ShopMoney: true);

    return source.TotalShippingPriceSet?.ShopMoney?.Amount
        ?? source.CurrentShippingPriceSet?.ShopMoney?.Amount;
}
```

Si el pedido tiene líneas de envío explícitas, se usa `GetDeliveryCost()` del ShopifySDK (calcula el coste sin IVA). Si no, se lee directamente el campo de resumen.

### `GetProductId(LineItem source)` y `GetLineTitle(LineItem source)` y `GetLineTotal(LineItem source)`

```csharp
private static string  GetProductId(LineItem source)  => source.Sku ?? string.Empty;
private static string  GetLineTitle(LineItem source)   => source.Name;
private static decimal GetLineTotal(LineItem source)
    => source.DiscountedTotalSet?.ShopMoney?.Amount
       ?? source.OriginalTotalSet?.ShopMoney?.Amount
       ?? 0m;
```

El SKU de la variante (campo `Sku` de `LineItem`) se usa como referencia del artículo en el ERP. El total de línea usa el importe descontado si existe, o el original en caso contrario.

### `GetLinePrice(LineItem source)`

```csharp
private static decimal GetLinePrice(LineItem source)
{
    if (source.Quantity > 0 && source.OriginalTotalSet is not null)
        return source.GetLineItemPrice(false, true);

    return source.OriginalUnitPriceSet?.ShopMoney?.Amount
        ?? source.DiscountedUnitPriceSet?.ShopMoney?.Amount
        ?? 0m;
}
```

El precio unitario se calcula dividiendo el total original entre la cantidad (usando `GetLineItemPrice` del ShopifySDK). Si no se puede calcular así, se usan los campos de precio unitario directos.

### `GetShippingAddressIfDropshipping(Order source)`

```csharp
private static OrderShippingAddressModel? GetShippingAddressIfDropshipping(Order source)
{
    if (!IsDropshipping(source))
        return null;

    var address = source.ShippingAddress;

    return new OrderShippingAddressModel
    {
        FirstName   = address?.FirstName,
        LastName    = address?.LastName,
        Address1    = address?.Address1,
        Address2    = address?.Address2,
        City        = address?.City,
        Zip         = address?.Zip,
        Province    = address?.Province,
        Country     = address?.Country,
        Phone       = address?.Phone,
        CountryCode = address?.CountryCodeV2?.ToString(),
        ProvinceCode = address?.ProvinceCode
    };
}
```

Solo rellena la dirección de envío en el modelo del ERP si `IsDropshipping` devuelve `true`. Si no es dropshipping, el ERP ya conoce la dirección de la sucursal y no hace falta repetirla.

---

## 10. OrdersMappingProfile — lógica de descuentos

**Fichero:** `Transformers/Mapper/OrdersMappingProfile.cs`

La lógica de descuentos es la parte más compleja del perfil. Shopify separa los descuentos en dos tipos (porcentaje e importe fijo) y los aplica a nivel de cabecera y de línea.

### `SetHeaderDiscountFields(Order source, OrderHeaderModel destination)`

```csharp
private static void SetHeaderDiscountFields(Order source, OrderHeaderModel destination)
{
    var percentageAmount = GetHeaderPercentageDiscountAmount(source);
    var fixedAmount      = GetHeaderFixedDiscountAmount(source);

    destination.TotalDiscount      = fixedAmount == 0m ? 0m : fixedAmount;
    destination.TotalDiscountPrcnt = percentageAmount == 0m ? null : percentageAmount;
}
```

Se llama mediante `AfterMap` una vez que el resto del mapeo ha terminado. Rellena los dos campos de descuento de cabecera separando el importe fijo del porcentual. `TotalDiscountPrcnt` se deja a `null` si no hay descuento de porcentaje.

### `GetHeaderFixedDiscountAmount` y `GetHeaderPercentageDiscountAmount`

```csharp
private static decimal GetHeaderFixedDiscountAmount(Order source)
    => source.LineItems?.Nodes?
           .SelectMany(x => x.DiscountAllocations ?? [])
           .Where(x => x.DiscountApplication?.AllocationMethod == DiscountApplicationAllocationMethod.ACROSS)
           .Where(x => IsFixedAmountDiscountApplication(x.DiscountApplication))
           .Sum(x => x.AllocatedAmountSet?.ShopMoney?.Amount ?? 0m)
       ?? 0m;

private static decimal GetHeaderPercentageDiscountAmount(Order source)
    => source.LineItems?.Nodes?
           .SelectMany(x => x.DiscountAllocations ?? [])
           .Where(x => x.DiscountApplication?.AllocationMethod == DiscountApplicationAllocationMethod.ACROSS)
           .Where(x => IsPercentageDiscountApplication(x.DiscountApplication))
           .Sum(x => x.AllocatedAmountSet?.ShopMoney?.Amount ?? 0m)
       ?? 0m;
```

Los descuentos a nivel de cabecera son aquellos con `AllocationMethod = ACROSS` (distribuidos entre todas las líneas). Se suman los montos asignados a cada línea filtrando por tipo (fijo o porcentual).

### `SetLineDiscountFields(LineItem source, OrderLineModel destination)`

```csharp
private static void SetLineDiscountFields(LineItem source, OrderLineModel destination)
{
    var percentageAmount       = GetLinePercentageDiscountAmount(source);
    var lineAllocationsAmount  = GetLineAllocationsDiscountAmount(source);
    var totalDiscountSetAmount = source.TotalDiscountSet?.ShopMoney?.Amount;
    var totalAmount = lineAllocationsAmount > 0m
        ? lineAllocationsAmount
        : totalDiscountSetAmount.GetValueOrDefault();

    if (percentageAmount > totalAmount)
        percentageAmount = totalAmount;

    var fixedAmount = totalAmount - percentageAmount;

    destination.TotalDiscount      = fixedAmount;
    destination.TotalDiscountPrcnt = percentageAmount == 0m ? null : percentageAmount;
}
```

Los descuentos de línea son los que tienen `AllocationMethod != ACROSS`. La lógica garantiza que `percentageAmount <= totalAmount` (si por algún motivo de redondeo el porcentaje supera el total, se recorta). El importe fijo se calcula como la diferencia.

### `GetLinePercentageDiscountAmount` y `GetLineAllocationsDiscountAmount`

```csharp
private static decimal GetLinePercentageDiscountAmount(LineItem source)
    => source.DiscountAllocations?
           .Where(x => IsLineDiscountAllocation(x.DiscountApplication))
           .Where(x => IsPercentageDiscountApplication(x.DiscountApplication))
           .Sum(x => x.AllocatedAmountSet?.ShopMoney?.Amount ?? 0m)
       ?? 0m;

private static decimal GetLineAllocationsDiscountAmount(LineItem source)
    => source.DiscountAllocations?
           .Where(x => IsLineDiscountAllocation(x.DiscountApplication))
           .Sum(x => x.AllocatedAmountSet?.ShopMoney?.Amount ?? 0m)
       ?? 0m;

private static bool IsLineDiscountAllocation(ManualDiscountApplication? application)
    => application?.AllocationMethod != DiscountApplicationAllocationMethod.ACROSS;
```

### `IsPercentageDiscountApplication` y `IsFixedAmountDiscountApplication`

```csharp
private static bool IsPercentageDiscountApplication(ManualDiscountApplication? application)
{
    if (application?.Value is PricingPercentageValue)
        return true;

    if (application?.Value is JObject objectValue && objectValue.ContainsKey("percentage"))
        return true;

    return application?.Value?.ToString()
        ?.Contains("percentage", StringComparison.OrdinalIgnoreCase) == true;
}

private static bool IsFixedAmountDiscountApplication(ManualDiscountApplication? application)
    => GetDiscountApplicationAmount(application) != 0m;

private static decimal GetDiscountApplicationAmount(ManualDiscountApplication? application)
{
    if (application?.Value is MoneyV2 moneyValue)
        return moneyValue.Amount;

    if (application?.Value is JObject objectValue && objectValue.ContainsKey("amount"))
        return objectValue["amount"]?.ToObject<decimal>() ?? 0m;

    return 0m;
}
```

El campo `Value` del descuento puede llegar como tipos distintos dependiendo de cómo se creó el descuento en Shopify. Por eso hay tres rutas para detectar si es porcentual: tipo nativo `PricingPercentageValue`, objeto JSON con clave `"percentage"`, o string que contiene la palabra "percentage".

---

## 11. OrdersMappingProfile — IsDropshipping y normalización

**Fichero:** `Transformers/Mapper/OrdersMappingProfile.cs`

### `IsDropshipping(Order order)`

```csharp
private static bool IsDropshipping(Order order)
{
    var purchasingCompany = order.GetCompanyDetailsForCustomer();

    var orderAddress    = order.ShippingAddress;
    var locationAddress = purchasingCompany?.Location?.ShippingAddress;

    if (orderAddress is null || locationAddress is null)
        return false;

    return !Same(orderAddress.Address1, locationAddress.Address1)
        || !Same(orderAddress.Zip,      locationAddress.Zip)
        || !Same(orderAddress.Province, locationAddress.Province)
        || !Same(orderAddress.Country,  locationAddress.Country);
}
```

Compara la dirección de envío del pedido con la dirección registrada para la sucursal en Shopify B2B. Si difieren en alguno de los cuatro campos (dirección, código postal, provincia, país), es dropshipping. Los campos `FirstName`, `LastName` o teléfono no se comparan porque pueden variar aunque el envío sea a la misma dirección.

Si no se puede obtener la dirección de la sucursal (null), se asume que NO es dropshipping para no bloquear el pedido.

### `Same(string? left, string? right)` y `Normalize(string? value)`

```csharp
private static bool Same(string? left, string? right)
    => string.Equals(
        Normalize(left),
        Normalize(right),
        StringComparison.OrdinalIgnoreCase
    );

private static string Normalize(string? value)
    => string.IsNullOrWhiteSpace(value)
        ? string.Empty
        : value.Trim();
```

La comparación es insensible a mayúsculas y elimina espacios al principio y al final. Un `null` y un string vacío son equivalentes (ambos se normalizan a `""`).

---

## 12. ProductosMappingTransforms — mapeos AutoMapper

**Fichero:** `Transformers/Mapper/ProductosMappingTransforms.cs`

Este perfil define tres mapeos para la transformación de productos. Se instancia en los transformers de productos pasándole `IConfiguration` y opcionalmente `ILogger`.

### `CreateMap<Product, ProductCreateInput>`

```csharp
CreateMap<Product, ProductCreateInput>()
    .ForMember(dest => dest.DescriptionHtml, opt => opt.MapFrom(src => GetRepresentativeSource(src).LongProductDescription.Get("es")))
    .ForMember(dest => dest.Title,           opt => opt.MapFrom(src => GetProductTitle(src)))
    .ForMember(dest => dest.Seo,             opt => opt.MapFrom(src => GetSeo(src)))
    .ForMember(dest => dest.Handle,          opt => opt.MapFrom(src => GetUrlSeo(src)))
    .ForMember(dest => dest.Status,          opt => opt.MapFrom(src => GetProductStatus(src.Status)))
    .ForMember(dest => dest.Tags,            opt => opt.MapFrom(src => GetTags(src)))
    .ForMember(dest => dest.Metafields,      opt => opt.MapFrom(src => GetMetafieldsProducto(src)))
    .ForMember(dest => dest.ProductOptions,  opt => opt.MapFrom(src => GetProductOptions(src)))
    .ForMember(dest => dest.Vendor,          opt => opt.MapFrom(src => GetRepresentativeSource(src).Brand.FirstOrDefault()));
```

### `CreateMap<Product, ProductUpdateInput>`

```csharp
CreateMap<Product, ProductUpdateInput>()
    .ForMember(dest => dest.DescriptionHtml, opt => opt.MapFrom(src => GetRepresentativeSource(src).LongProductDescription.Get("es")))
    .ForMember(dest => dest.Title,           opt => opt.MapFrom(src => GetProductTitle(src)))
    .ForMember(dest => dest.Seo,             opt => opt.MapFrom(src => GetSeo(src)))
    .ForMember(dest => dest.Handle,          opt => opt.MapFrom(src => GetRepresentativeSource(src).UrlSeo))
    .ForMember(dest => dest.Status,          opt => opt.MapFrom(src => GetProductStatus(src.Status)))
    .ForMember(dest => dest.Tags,            opt => opt.MapFrom(src => GetTags(src)))
    .ForMember(dest => dest.Metafields,      opt => opt.MapFrom(src => GetMetafieldsProducto(src)))
    .ForMember(dest => dest.Vendor,          opt => opt.MapFrom(src => GetRepresentativeSource(src).Brand.FirstOrDefault()));
```

La diferencia con el mapeo de creación: en la actualización `Handle` viene directamente de `UrlSeo` (sin lógica de multi-variante) y no hay `ProductOptions` (las opciones no se reconstruyen en una actualización normal).

### `CreateMap<(Variant, List<string>, Dictionary<string, string>), ProductVariantsBulkInput>`

```csharp
CreateMap<(Variant variant, List<string> mediasIds, Dictionary<string, string> variantOriginIdsToShopifyIds),
          ProductVariantsBulkInput>()
    .ForMember(dest => dest.Id,             opt => opt.Ignore())
    .ForMember(dest => dest.Price,          opt => opt.MapFrom(src => ParseDecimalOrNull(src.variant.OriginObject.SalonSpaceSellingPrice)))
    .ForMember(dest => dest.Barcode,        opt => opt.MapFrom(src => EmptyToNull(src.variant.OriginObject.Ean)))
    .ForMember(dest => dest.Metafields,     opt => opt.MapFrom(src => GetMetafieldsVariante(src.variant, src.mediasIds, src.variantOriginIdsToShopifyIds)))
    .ForMember(dest => dest.OptionValues,   opt => opt.MapFrom(src => GetOptionVariante(src.variant)))
    .ForMember(dest => dest.InventoryItem,  opt => opt.MapFrom(src => GetInventoryItem(src.variant)));
```

Este mapeo recibe una **tupla** de tres elementos porque la variante sola no tiene toda la información necesaria: se necesitan también los IDs de medias de Shopify (para el metafield `galeria_imagenes`) y el mapa de OriginIds de variantes a DestinoIds (para el metafield `pack_profesionales`).

`Id` se ignora en este mapeo — en creación no existe aún; en actualización se asigna antes de llamar al mapper.

---

## 13. ProductosMappingTransforms — GetMetafieldsProducto

**Fichero:** `Transformers/Mapper/ProductosMappingTransforms.cs`

Genera la lista completa de metafields del producto. Está envuelta en un `try/catch` salvo el último metafield (`tax-class`), que se deja fuera intencionadamente.

```csharp
private List<MetafieldInput> GetMetafieldsProducto(Product producto)
{
    var list   = new List<MetafieldInput>();
    var source = GetRepresentativeSource(producto);

    try
    {
        AddMetafield(list, "upng",         "originId",                    SingleLineTextField, producto.OriginId);
        AddMetafield(list, "upng",         "referencia",                  SingleLineTextField, producto.OriginId);
        AddMetafield(list, "upng",         "last_sync",                   SingleLineTextField, DateTime.Now.ToString("dd-MM-yyyy HH:mm"));
        AddMetafield(list, "product",      "is_discontinued",             Boolean,             source.Obsoleto.ToString().ToLowerInvariant());
        AddMetafield(list, "product_info", "prod_ss_description_short",   MultiLineTextField,  source.ShortProductDescription.Get("es"));
        AddMetafield(list, "product_info", "more_details",                MultiLineTextField,  source.AdditionalBenefits.Get("es"));
        AddMetafield(list, "product_info", "prod_ingredients",            MultiLineTextField,  source.Ingredients.Get("es"));
        AddMetafield(list, "product_info", "prod_ss_instructions",        MultiLineTextField,  source.HowToUse.Get("es"));
        AddMetafield(list, "brand",        "prod_brand",                  SingleLineTextField, FirstOrNull(source.Brand));
        AddMetafield(list, "upng",         "shopify_line_brand",          SingleLineTextField, source.ShopifyLineaMarca);
        AddMetafield(list, "upng",         "shopify_category",            SingleLineTextField, source.ShopifyCategory);
        AddMetafield(list, "upng",         "shopify_subcategory",         SingleLineTextField, source.ShopifySubcategory);
        AddMetafield(list, "upng",         "benefits",                    MultiLineTextField,  source.Benefits.Get("es"));
        AddMetafield(list, "upng",         "key_features",                MultiLineTextField,  source.KeyFeatures.Get("es"));
        AddMetafield(list, "upng",         "warranties_and_certifications", MultiLineTextField, source.WarrantiesAndCertifications.Get("es"));
        AddMetafield(list, "upng",         "safety_warning_content",      MultiLineTextField,  source.SafetyWarningContent);
        AddMetafield(list, "upng",         "brand_line",                  SingleLineTextField, source.BrandLine);
        AddMetafield(list, "upng",         "brand_family",                SingleLineTextField, source.BrandFamily);
        AddMetafield(list, "upng",         "brand_subfamily",             SingleLineTextField, source.BrandSubfamily);
        AddMetafield(list, "upng",         "product_class",               SingleLineTextFieldList, ToJsonList(ToStringList(source.ProductClass)));
        AddMetafield(list, "upng",         "target_gender",               SingleLineTextFieldList, ToJsonList(source.TargetGender));
        AddMetafield(list, "upng",         "hair_need",                   SingleLineTextFieldList, ToJsonList(ToStringList(source.HairNeed)));
        AddMetafield(list, "upng",         "category_name",               SingleLineTextField, source.CategoryName);
        AddMetafield(list, "upng",         "descargar_ficha_tecnica",     Url,                 EmptyToNull(source.FichaTecnica));

        foreach (var mapping in GetProductCustomFilterMappings(source))
        {
            AddMetafield(list, "custom", mapping.Key, SingleLineTextField, mapping.Value);
        }
    }
    catch (Exception ex)
    {
        _logger?.LogError(ex, "Error al generar los metafields para el producto {id}", producto.OriginId);
    }

    // Fuera del try/catch a propósito: si NivelImpuesto es desconocido, el producto falla completamente
    AddMetafield(list, "upng", "tax-class", SingleLineTextField, source.NivelImpuesto switch
    {
        "NOR" => "21",
        "RED" => "10",
        "SRD" => "4",
        _     => throw new NotImplementedException(
                     $"No se ha definido el mapeo para el valor de impuesto {source.NivelImpuesto}")
    });

    return list;
}
```

**Por qué `tax-class` está fuera del `try/catch`:** si un producto no tiene un tipo de IVA reconocido, la sincronización de ese producto debe fallar de forma visible. Metiéndolo dentro del `try/catch` podría subirse a Shopify sin IVA y nadie se daría cuenta.

**`GetProductCustomFilterMappings`:** devuelve ~50 pares `(key, value)` donde cada clave es un nombre de metafield `custom.filtro_*` y el valor es el campo correspondiente de `SalonSpaceProduct`. Se generan para los filtros de búsqueda del catálogo (tintes, styling, depilación, accesorios, etc.). Los metafields con valor `null` o vacío se omiten mediante `AddMetafield`.

---

## 14. ProductosMappingTransforms — GetMetafieldsVariante

**Fichero:** `Transformers/Mapper/ProductosMappingTransforms.cs`

```csharp
private static List<MetafieldInput> GetMetafieldsVariante(
    Variant variante,
    List<string> mediasShopifyIds,
    Dictionary<string, string> variantOriginIdsToShopifyIds)
{
    var source = variante.OriginObject;
    var list   = new List<MetafieldInput>();

    AddMetafield(list, "upng",         "originId",               SingleLineTextField,     variante.OriginId);
    AddMetafield(list, "upng",         "tags_shopify",           SingleLineTextFieldList, ToJsonList(source.Etiqueta));
    AddMetafield(list, "upng",         "benefits",               MultiLineTextField,      source.Benefits.Get("es"));
    AddMetafield(list, "product_info", "more_details",           MultiLineTextField,      source.AdditionalBenefits.Get("es"));
    AddMetafield(list, "upng",         "key_features",           MultiLineTextField,      source.KeyFeatures.Get("es"));
    AddMetafield(list, "product_info", "prod_ss_instructions",   MultiLineTextField,      source.HowToUse.Get("es"));
    AddMetafield(list, "upng",         "ean_1",                  SingleLineTextField,     EmptyToNull(source.Ean1));
    AddMetafield(list, "upng",         "ean_2",                  SingleLineTextField,     EmptyToNull(source.Ean2));
    AddMetafield(list, "upng",         "ean_3",                  SingleLineTextField,     EmptyToNull(source.Ean3));
    AddMetafield(list, "upng",         "hair_type",              SingleLineTextField,     source.HairType.Get("es"));
    AddMetafield(list, "upng",         "hair_need",              SingleLineTextFieldList, ToJsonList(ToStringList(source.HairNeed)));
    AddMetafield(list, "upng",         "content_type",           SingleLineTextField,     source.ContentType.FirstOrDefault());
    AddMetafield(list, "upng",         "content_value",          Integer,                 source.ContentValue);
    AddMetafield(list, "upng",         "color",                  SingleLineTextField,     source.Color.Get("es"));
    AddMetafield(list, "upng",         "units_per_box",          Integer,                 ParseIntegerString(source.UnitsPerBox));
    AddMetafield(list, "upng",         "weight",                 Decimal,                 ParseDecimalString(source.Weight));
    AddMetafield(list, "upng",         "PVP",                    Decimal,                 ParseDecimalString(source.SalonSpaceSellingPrice));
    AddMetafield(list, "upng",         "special_selling_price",  Decimal,                 ParseDecimalString(source.SalonSpaceSpecialSellingPrice));
    AddMetafield(list, "variant",      "codigo_agrupacion",      SingleLineTextField,     source.CodigoAgrupacion);

    // IDs de medias de Shopify para la galería de imágenes
    AddMetafield(list, "upng", "galeria_imagenes", ListFileReference, ToJsonList(mediasShopifyIds));

    // OriginIds de variantes del pack, resueltos a DestinoIds de Shopify
    var packs = source.PrvPacksSkus1
        .Select(x => variantOriginIdsToShopifyIds.GetValueOrDefault($"{x.Value}#{x.Key}"))
        .DiscardNulls()
        .ToArray();
    AddMetafield(list, "upng", "pack_profesionales", VariantReferenceList, JsonConvert.SerializeObject(packs));

    return list;
}
```

**Los dos metafields especiales:**

- `galeria_imagenes`: lista JSON de IDs de medias de Shopify. Solo tiene contenido en la **actualización** — en la creación, las imágenes aún no existen en Shopify. Se pasa la lista `mediasShopifyIds` que viene del transformer.
- `pack_profesionales`: lista de variantes que forman parte de un pack. El campo `PrvPacksSkus1` del PIM almacena pares `{Sku, Id}` de las variantes del pack. Se resuelven a DestinoIds usando el mapa `variantOriginIdsToShopifyIds`. Las variantes que no estén en el mapa se descartan silenciosamente.

---

## 15. ProductosMappingTransforms — helpers de producto

**Fichero:** `Transformers/Mapper/ProductosMappingTransforms.cs`

### `GetRepresentativeSource(Product producto)`

```csharp
private static SalonSpaceProduct GetRepresentativeSource(Product producto)
{
    var variant = producto.GetMainVariant();
    return variant.OriginObject;
}
```

La "fuente representativa" del producto es el `SalonSpaceProduct` de la variante principal. La variante principal es la que tiene el mismo SKU que el `CodigoAgrupacion`, y sus campos (nombre, descripción, imágenes, marca, etc.) son los que representan al producto padre.

### `GetProductTitle(Product product)`

```csharp
private string GetProductTitle(Product product)
    => product.GetNumVariants() > 1
        ? GetRepresentativeSource(product).ParentProductName.Get("es")
        : GetRepresentativeSource(product).NombreProducto.Get("es");
```

Para productos con múltiples variantes se usa el nombre del grupo (`parent_product_name`). Para productos simples se usa el nombre del artículo (`nombre_producto`).

### `GetSeo(Product product)`

```csharp
private static SEOInput? GetSeo(Product product)
{
    var source = GetRepresentativeSource(product);

    string? title, description;

    if (product.GetNumVariants() > 1)
    {
        title       = EmptyToNull(source.ParentMetatitle);
        description = EmptyToNull(source.ParentMetadescription);
    }
    else
    {
        title       = EmptyToNull(source.MetaTitle.Get("es"));
        description = EmptyToNull(source.MetaDescription.Get("es"));
    }

    if (title is null && description is null)
        return null;

    return new SEOInput { Title = title, Description = description };
}
```

Si ambos campos SEO están vacíos, devuelve `null` (Shopify ignora un `SEOInput` null). Lo mismo que el título: productos con variantes usan el campo `parent_*` y los simples usan el campo individual.

### `GetUrlSeo(Product product)`

```csharp
private static string GetUrlSeo(Product product)
    => product.GetNumVariants() > 1
        ? GetRepresentativeSource(product).ParentUrlSeo
        : GetRepresentativeSource(product).UrlSeo;
```

El handle (slug URL) del producto en Shopify.

### `GetTags(Product product)`

```csharp
private static List<string> GetTags(Product product) => NormalizeStringList(product.GetTags());
```

Delega en `product.GetTags()` (de `04c` sección 6) y luego normaliza la lista con `NormalizeStringList`.

### `GetProductOptions(IProduct product)`

```csharp
private static List<OptionCreateInput> GetProductOptions(IProduct product)
{
    var resultado = new List<OptionCreateInput>();
    int position  = 1;
    foreach (var option in product.GetSortedOptions())
    {
        resultado.Add(new OptionCreateInput
        {
            Name     = option.Key,
            Values   = option.Value.Select(x => new OptionValueCreateInput { Name = x }).ToList(),
            Position = position,
        });
        position++;
    }
    return resultado;
}
```

Convierte el diccionario `{nombre → [valores]}` que devuelve [`GetSortedOptions()`](04c-extractors-metodos.md#getsortedoptions) en la lista de `OptionCreateInput` que espera la API de Shopify. La posición comienza en 1 (no en 0) porque Shopify usa posición 1-based.

### `GetProductStatus(EntityStatus status)`

```csharp
private static ProductStatus GetProductStatus(EntityStatus status) => status switch
{
    EntityStatus.Active   => ProductStatus.ACTIVE,
    EntityStatus.Inactive => ProductStatus.DRAFT,
    EntityStatus.Deleted  => ProductStatus.ARCHIVED,
    _ => throw new ArgumentOutOfRangeException(nameof(status), status, null)
};
```

Convierte el `EntityStatus` interno al `ProductStatus` de la API de Shopify. Si llega un valor desconocido, lanza excepción.

### `AddMetafield(List<MetafieldInput> list, string ns, string key, MetafieldTypeNum type, string? value)`

```csharp
private static void AddMetafield(
    List<MetafieldInput> list,
    string ns, string key,
    MetafieldTypeNum type,
    string? value)
{
    if (string.IsNullOrWhiteSpace(value))
        return;

    // Limpiar saltos de línea en campos de línea única
    if (type is MetafieldTypeNum.SingleLineTextField)
        value = value.Replace("\r\n", " ").Replace("\n", " ");

    list.Add(new MetafieldInput
    {
        Namespace = ns,
        Key       = key,
        Type      = type,
        Value     = value
    });
}
```

Método de utilidad que evita añadir metafields vacíos (Shopify los ignoraría pero contaminaría el request). Para campos `SingleLineTextField` también elimina saltos de línea, que están prohibidos en ese tipo de metafield.

---

## 16. ProductosMappingTransforms — helpers de tipos

**Fichero:** `Transformers/Mapper/ProductosMappingTransforms.cs`

Métodos de conversión de tipos del PIM (strings con comas, listas de objetos) a los tipos que espera la API de Shopify.

### `ParseDecimalOrNull` y `ParseDecimalString`

```csharp
private static decimal? ParseDecimalOrNull(string? value)
{
    if (string.IsNullOrWhiteSpace(value))
        return null;

    var normalized = value.Trim().Replace(",", ".");
    if (decimal.TryParse(normalized, NumberStyles.Number, CultureInfo.InvariantCulture, out var result))
        return result;

    return null;
}

private static string? ParseDecimalString(string? value)
{
    var parsed = ParseDecimalOrNull(value);
    return parsed?.ToString(CultureInfo.InvariantCulture);
}
```

El PIM almacena precios y pesos como strings con coma decimal (ej: `"19,95"`). Se normalizan a punto para parsear con `InvariantCulture`. `ParseDecimalString` convierte el resultado de vuelta a string con notación invariante (punto).

### `ParseIntegerOrNull` y `ParseIntegerString`

```csharp
private static int? ParseIntegerOrNull(string? value)
{
    if (string.IsNullOrWhiteSpace(value))
        return null;

    var normalized = value.Trim().Replace(",", ".");
    if (int.TryParse(normalized, NumberStyles.Integer, CultureInfo.InvariantCulture, out var result))
        return result;

    // Si viene como decimal ("3,0"), truncar a entero
    if (decimal.TryParse(normalized, NumberStyles.Number, CultureInfo.InvariantCulture, out var decimalResult))
        return (int)decimalResult;

    return null;
}

private static string? ParseIntegerString(string? value)
{
    var parsed = ParseIntegerOrNull(value);
    return parsed?.ToString(CultureInfo.InvariantCulture);
}
```

Similar al decimal, pero permite que llegue un valor como `"3,0"` y lo trunca a `3`.

### `EmptyToNull(string? value)`

```csharp
private static string? EmptyToNull(string? value)
    => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
```

Convierte strings vacíos o solo-espacios a `null`. Usado para garantizar que `AddMetafield` recibe `null` (y lo omite) en lugar de un string vacío.

### `FirstOrNull(IEnumerable<string?> values)`

```csharp
private static string? FirstOrNull(IEnumerable<string?> values)
    => NormalizeStringList(values).FirstOrDefault();
```

Devuelve el primer elemento no vacío de una lista, o `null` si todos están vacíos.

### `ToJsonList(IEnumerable<string?> values)`

```csharp
private static string? ToJsonList(IEnumerable<string?> values)
{
    var list = NormalizeStringList(values);
    return list.Count == 0 ? null : JsonSerializer.Serialize(list);
}
```

Serializa una lista de strings a JSON (ej: `["rojo", "azul"]`). Si la lista está vacía, devuelve `null` para que `AddMetafield` la omita.

### `ToStringList(IEnumerable<object?> values)`

```csharp
private static List<string> ToStringList(IEnumerable<object?> values)
    => values
        .Where(x => x is not null && !string.IsNullOrWhiteSpace(x.ToString()))
        .Select(x => x!.ToString()!.Trim())
        .Distinct()
        .ToList();
```

Convierte listas de objetos (los campos de tipo `object?` del PIM que pueden ser enums o strings) a listas de strings.

### `NormalizeStringList(IEnumerable<string?> values)`

```csharp
private static List<string> NormalizeStringList(IEnumerable<string?> values)
    => values
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Select(x => x!.Trim().Replace("\r\n", " ").Replace("\n", " "))
        .Distinct()
        .ToList();
```

Normaliza una lista de strings: elimina nulos/vacíos, hace trim, reemplaza saltos de línea por espacios y deduplica.

---

## 17. ProductosMappingTransforms — helpers de variante

**Fichero:** `Transformers/Mapper/ProductosMappingTransforms.cs`

### `GetInventoryItem(Variant variante)`

```csharp
private static InventoryItemInput GetInventoryItem(Variant variante)
{
    var source = variante.OriginObject;

    return new InventoryItemInput
    {
        Sku              = EmptyToNull(source.Sku),
        Tracked          = GetInventoryTrackingTracked(source.SkuType),
        RequiresShipping = GetRequiresShipping(source.SkuType),
    };
}
```

`Tracked` y `RequiresShipping` dependen del `SkuType` del artículo: si es "material" son `true`; si es "digital" son `false`.

### `GetOptionVariante(IVariant variante)`

```csharp
private static List<VariantOptionValueInput> GetOptionVariante(IVariant variante)
{
    var resultado = new List<VariantOptionValueInput>();
    foreach (var option in variante.GetSelectedOptions())
    {
        resultado.Add(new VariantOptionValueInput
        {
            OptionName = option.Key,
            Name       = option.Value,
        });
    }
    return resultado;
}
```

Convierte el diccionario de opciones de la variante (ej: `{"Color": "Negro", "Talla": "M"}`) a la lista de `VariantOptionValueInput` que espera la API de Shopify.

### `ParseSkuTypeAsMaterial(string skuType)`, `GetInventoryTrackingTracked` y `GetRequiresShipping`

```csharp
private static bool GetInventoryTrackingTracked(string skuType) => ParseSkuTypeAsMaterial(skuType);
private static bool GetRequiresShipping(string skuType)         => ParseSkuTypeAsMaterial(skuType);

private static bool ParseSkuTypeAsMaterial(string skuType)
{
    if (string.IsNullOrWhiteSpace(skuType))
        throw new ArgumentException("sku_type no puede venir vacío para mapear tracked/requiresShipping.");

    var normalized = skuType.Trim().ToLowerInvariant();

    if (bool.TryParse(normalized, out var parsedBool))
        return parsedBool;

    if (normalized.Contains("material"))
        return true;

    if (normalized.Contains("digital"))
        return false;

    throw new ArgumentException($"sku_type no soportado: {skuType}");
}
```

Clasifica el artículo como físico (material) o digital. Acepta tres formatos:
- `"true"` / `"false"` — booleano directo
- Cualquier string que contenga `"material"` — artículo físico
- Cualquier string que contenga `"digital"` — artículo digital

Si el `SkuType` está vacío o no coincide con ningún patrón, lanza excepción (igual que `tax-class`, es un error que debe ser visible).

---

## Resumen: qué método hace qué

| Clase | Método | Lo que hace en una línea |
|---|---|---|
| `CustomersMappingProfile` | `CreateMap<ClientResponseModel, CompanyInput>` | Mapea empresa ERP → Company Shopify (ExternalId + Name) |
| `CustomersMappingProfile` | `CreateMap<LocationResponseModel, CompanyContactInput>` | Mapea dirección → contacto de empresa (Email + Phone) |
| `CustomersMappingProfile` | `CreateMap<LocationResponseModel, CompanyLocationInput>` | Mapea dirección → sucursal de empresa con dirección completa |
| `CustomersMappingProfile` | `CreateMap<LocationResponseModel, CompanyLocationUpdateInput>` | Igual que el anterior más Phone y configuración de compra |
| `CustomersMappingProfile` | `BuildAddress` | Convierte dirección ERP → Shopify, resolviendo ISO de país y provincia |
| `ZoneCodes` | `TryGetZoneCode` | Busca el código ISO 3166-2 de una provincia en tabla CSV |
| `ZoneCodes` | `TryGetProvince` | Búsqueda inversa: código → nombre de provincia |
| `ZoneCodes` | `NormalizeProvince` | Elimina acentos y normaliza mayúsculas para comparación |
| `CustomerTransform` | `RunAsync` | Transforma 8 tipos de operación de clientes en una pasada |
| `CustomerTransform` | `GetMetafieldsCompany` | Genera metafield `upng.zona_fiscal` para la Company |
| `CustomerTransform` | `GetMetafieldsLocation` | Sin metafields por ahora (punto de extensión) |
| `CustomerTransform` | `GetMetafieldsCustomer` | Genera metafield `upng.external_id` para el contacto |
| `ICustomer` | `GetRoleOriginId` | Genera OriginId del rol: `"{locationOriginId}-{customerOriginId}"` |
| `OrdersMappingProfile` | `CreateMap<Order, OrderHeaderModel>` | Mapeo declarativo de cabecera de pedido |
| `OrdersMappingProfile` | `CreateMap<LineItem, OrderLineModel>` | Mapeo declarativo de línea de pedido |
| `OrdersMappingProfile` | `GetOrderId` | Extrae el nombre legible del pedido (`#SS4185`) como ID del ERP |
| `OrdersMappingProfile` | `GetLocationId` | Extrae el `CodAdr` del ERP del ExternalId de la sucursal |
| `OrdersMappingProfile` | `NormalizeShippingAddressId` | Elimina el prefijo `{CodCom}#` del ExternalId de la sucursal |
| `OrdersMappingProfile` | `GetPaymentTermsCode` | Une los métodos de pago con coma |
| `OrdersMappingProfile` | `GetShippingLinePrice` | Precio de envío sin IVA (usa ShopifySDK o campo directo) |
| `OrdersMappingProfile` | `GetShippingAddressIfDropshipping` | Devuelve la dirección del pedido solo si es dropshipping |
| `OrdersMappingProfile` | `SetHeaderDiscountFields` | Calcula y asigna descuentos de cabecera (fijo + porcentual) |
| `OrdersMappingProfile` | `SetLineDiscountFields` | Calcula y asigna descuentos de línea |
| `OrdersMappingProfile` | `IsPercentageDiscountApplication` | Detecta si un descuento de Shopify es de tipo porcentaje |
| `OrdersMappingProfile` | `IsDropshipping` | Compara dirección del pedido con la de la sucursal |
| `OrdersMappingProfile` | `Same` / `Normalize` | Comparación insensible a mayúsculas y espacios |
| `ProductosMappingTransforms` | `CreateMap<Product, ProductCreateInput>` | Mapeo declarativo de producto para creación |
| `ProductosMappingTransforms` | `CreateMap<Product, ProductUpdateInput>` | Mapeo declarativo de producto para actualización |
| `ProductosMappingTransforms` | `CreateMap<(Variant,...), ProductVariantsBulkInput>` | Mapeo declarativo de variante (con medias y packs) |
| `ProductosMappingTransforms` | `GetMetafieldsProducto` | Genera 25+ metafields del producto con los campos del PIM |
| `ProductosMappingTransforms` | `GetMetafieldsVariante` | Genera 20+ metafields de variante incluyendo galería y packs |
| `ProductosMappingTransforms` | `GetProductCustomFilterMappings` | Genera ~50 metafields `custom.filtro_*` para los filtros del catálogo |
| `ProductosMappingTransforms` | `GetRepresentativeSource` | Devuelve el `SalonSpaceProduct` de la variante principal |
| `ProductosMappingTransforms` | `GetProductTitle` | Nombre del producto: campo padre si multi-variante, individual si simple |
| `ProductosMappingTransforms` | `GetSeo` | Título y descripción SEO del producto |
| `ProductosMappingTransforms` | `GetUrlSeo` | Handle (slug URL) del producto para Shopify |
| `ProductosMappingTransforms` | `GetProductOptions` | Convierte `GetSortedOptions()` al formato `OptionCreateInput[]` |
| `ProductosMappingTransforms` | `GetProductStatus` | `EntityStatus` → `ProductStatus` de Shopify |
| `ProductosMappingTransforms` | `AddMetafield` | Añade un metafield a la lista omitiendo los vacíos |
| `ProductosMappingTransforms` | `GetInventoryItem` | Construye `InventoryItemInput` (SKU, tracked, requiresShipping) |
| `ProductosMappingTransforms` | `GetOptionVariante` | Convierte opciones de variante al formato `VariantOptionValueInput[]` |
| `ProductosMappingTransforms` | `ParseSkuTypeAsMaterial` | Clasifica "material" (físico) vs "digital" según `SkuType` |
| `ProductosMappingTransforms` | `ParseDecimalOrNull` | Parsea string con coma decimal (ej: `"19,95"`) a `decimal?` |
| `ProductosMappingTransforms` | `ParseIntegerOrNull` | Parsea string a `int?`, incluyendo el caso `"3,0"` |
| `ProductosMappingTransforms` | `EmptyToNull` | Convierte strings vacíos a `null` |
| `ProductosMappingTransforms` | `ToJsonList` | Serializa lista de strings a JSON o devuelve null si vacía |
| `ProductosMappingTransforms` | `NormalizeStringList` | Limpia, deduplica y normaliza saltos de línea en listas de strings |
