---
tags:
  - Extractors
  - ERP
  - PIM
---

# 04c — Extractors: métodos y funciones en detalle

Este documento explica paso a paso **cada método y función** que interviene en la capa de extracción. El objetivo es que, cuando en los documentos [`04-extractors.md`](04-extractors.md) o [`04b-extractors-detalle.md`](04b-extractors-detalle.md) se mencione una clase o un método concreto, puedas venir aquí y entender exactamente qué hace, con su código completo.

---

## Índice

1. [Infraestructura base de una actividad](#1-infraestructura-base-de-una-actividad)
2. [FuncUtils.WithCachedRun — la caché de desarrollo](#2-funcutilswithcachedrun-la-cache-de-desarrollo)
3. [ProvallianceAuthenticationHelperService](#3-provallianceauthenticationhelperservice)
4. [ProvallianceService](#4-provallianceservice)
5. [ProductsWithImagesExtract — RunAsync](#5-productswithimagesextract-runasync)
6. [Product — constructor y métodos](#6-product-constructor-y-metodos)
7. [Variant — constructor y métodos](#7-variant-constructor-y-metodos)
8. [CustomerExtract — RunAsync](#8-customerextract-runasync)
9. [StockExtract — RunAsync](#9-stockextract-runasync)
10. [LocalImagesExtractor — RunAsync](#10-localimagesextractor-runasync)
11. [TranslationsExtract — InitInputs y RunAsync](#11-translationsextract-initinputs-y-runasync)
12. [ExtractTarifas — RunAsync (stub)](#12-extracttarifas-runasync-stub)
13. [ShopifyExtract — RunAsync (migración)](#13-shopifyextract-runasync-migracion)
14. [ClientResponseModel — métodos de ICompany](#14-clientresponsemodel-metodos-de-icompany)
15. [LocationResponseModel — métodos de ILocation e ICustomer](#15-locationresponsemodel-metodos-de-ilocation-e-icustomer)
16. [Orders.Retrieve — ShopifySDK](#16-ordersretrieve-shopifysdk)
17. [GetCompanyDetailsForCustomer — ShopifySDK](#17-getcompanydetailsforcustomer-shopifysdk)
18. [BulkGetAllWithVariantsExtended — ShopifySDK](#18-bulkgetallwithvariantsextended-shopifysdk)

---

## 1. Infraestructura base de una actividad

Todos los extractors heredan de `BaseActivity<T>`. Esta clase base establece el contrato que todo extractor debe cumplir: tres métodos que Elsa llama en orden.

```text
Elsa llama a la actividad
        │
        ▼
1. InitInputs(context)   ← leer los inputs que vienen del workflow
        │
        ▼
2. ShouldRunAsync()      ← ¿debe ejecutarse?  true / false
        │
        ├── false → la actividad se salta silenciosamente
        │
        └── true  ▼
3. RunAsync(context)     ← toda la lógica real
        │
        ▼
   ActivityResult        ← devuelve logs informativos para Elsa Studio
```

### `InitInputs(ActivityExecutionContext context)`

**Para qué sirve:** leer los valores de los inputs del workflow y guardarlos en campos privados de la clase antes de que empiece `RunAsync`. Esto centraliza la lectura de inputs en un único lugar y hace que `RunAsync` solo contenga lógica de negocio.

```csharp
// Ejemplo real de TranslationsExtract
protected override void InitInputs(ActivityExecutionContext context)
{
    _productos = ProductosInput.Get(context).Property.ToList();
}

// Los extractors sin inputs simplemente lo dejan vacío
protected override void InitInputs(ActivityExecutionContext context) { }
```

### `ShouldRunAsync()`

**Para qué sirve:** decidir en tiempo de ejecución si la actividad debe correr o no. Devuelve `true` o `false`.

**Por qué existe:** permite desactivar una actividad sin borrarla del código ni del workflow. En lugar de eliminar la clase, simplemente devuelves `false` y Elsa la salta como si no estuviera.

```csharp
protected override bool ShouldRunAsync() => true; // (1)!

protected override bool ShouldRunAsync() => false; // (2)!

protected override bool ShouldRunAsync() => _input.Count > 0; // (3)!
```
1. El extractor está activo. Elsa siempre llama a `RunAsync`.
2. El extractor está permanentemente desactivado (p.ej. `ShopifyExtract`). Elsa lo salta sin registrar ningún error.
3. `RunAsync` solo se ejecuta si `_input` tiene elementos. Evita que el transformer procese una lista vacía.

### `RunAsync(ActivityExecutionContext context)`

**Para qué sirve:** aquí vive toda la lógica del extractor. Es el método principal.

**Qué recibe:** el `ActivityExecutionContext` de Elsa, que da acceso al contenedor de dependencias del workflow (para obtener servicios como `ProvallianceService` o `SalesLayerClientService`) y al estado del workflow (para escribir los outputs).

**Qué devuelve:** un `ActivityResult`, que es un objeto con listas de mensajes informativos que aparecerán en Elsa Studio cuando el workflow termine.

```csharp
return new ActivityResult
{
    InformationLogs =
    [
        $"Recuperados {clientes.Count} clientes.",
    ]
};
```

---

## 2. FuncUtils.WithCachedRun — la caché de desarrollo

**Clase:** `SharedUtils.Utils.FuncUtils`
**Método:** `WithCachedRun<T>(Func<Task<T>> action, string folder, string fileName, ILogger logger)`

Este método es un envoltorio de caché que se usa en varios extractors. Su propósito es **evitar llamadas repetidas a APIs externas durante el desarrollo**.

### Cómo funciona paso a paso

```text
WithCachedRun(() => api.GetData(), "tmp/debug/prv/middleware", "clientes", logger)
        │
        ▼
1. ¿Existe el fichero "tmp/debug/prv/middleware/clientes.json"?
        │
        ├── SÍ → leer el fichero y deserializar como T
        │          (no se hace ninguna llamada a la API)
        │
        └── NO ▼
2. Ejecutar la función: api.GetData()
        │
        ▼
3. Serializar el resultado a JSON
        │
        ▼
4. Guardar en "tmp/debug/prv/middleware/clientes.json"
        │
        ▼
5. Devolver el resultado
```

### Por qué es útil

Sin caché, cada vez que ejecutas el workflow en local tienes que esperar a que la API de Provalliance responda (que puede tardar varios segundos y consume cuota). Con caché, la primera ejecución tarda lo normal, pero las siguientes son instantáneas.

### Dónde se usa

| Extractor | Carpeta | Fichero |
|---|---|---|
| `ProductsWithImagesExtract` | `tmp/debug/provalliance/saleslayer` | `salonspace` |
| `CustomerExtract` | `tmp/debug/provalliance/middleware` | `clientes` |
| `StockExtract` | `tmp/debug/provalliance/middleware` | `stock` |

**Importante:** estos ficheros de caché nunca deben subirse al repositorio. Están en `.gitignore`.

---

## 3. ProvallianceAuthenticationHelperService

**Fichero:** `Extractors/Services/ProvallianceAuthenticationHelperService.cs`

Este servicio gestiona el token de acceso OAuth2 para la API de Provalliance. Se registra como *singleton* en el contenedor de dependencias, lo que significa que hay **una sola instancia** para todo el proceso — y por tanto el token se reutiliza entre llamadas.

### `BuildAuthenticationHeader()`

**Firma:** `Task<AuthenticationHeaderValue> BuildAuthenticationHeader()`

**Para qué sirve:** devuelve la cabecera HTTP `Authorization: Bearer <token>` lista para añadir a cualquier petición. Es el punto de entrada público del servicio.

```csharp
public async Task<AuthenticationHeaderValue> BuildAuthenticationHeader()
{
    await EnsureIsAuthenticated();
    
    return new AuthenticationHeaderValue("Bearer", _authentication.ShouldNotBeNull().AccessToken);
}
```

1. Llama a `EnsureIsAuthenticated()` para garantizar que el token es válido.
2. Empaqueta el token en un `AuthenticationHeaderValue` de tipo `"Bearer"` y lo devuelve.

### `EnsureIsAuthenticated()`

**Firma:** `Task EnsureIsAuthenticated()`

**Para qué sirve:** garantizar que el campo interno `_authentication` contiene un token válido antes de usarlo. Gestiona los tres estados posibles del token.

=== "C#"

    ```csharp
    public async Task EnsureIsAuthenticated()
    {
        switch (_authentication?.HasExpired) // (1)!
        {
            case false:
                return; // (2)!
            case true:
                logger.LogInformation("La autenticación de Provalliance ha caducado, reautenticando...");
                goto TryAuthenticate; // (3)!
            default:
                logger.LogInformation("Autenticándose por primera vez en Provalliance...");
                goto TryAuthenticate;
        }

        TryAuthenticate: // (4)!
        {
            try
            {
                await Authenticate();
            }
            catch (Exception ex)
            {
                throw new Exception("An error occurred while performing the authentication!", ex);
            }
        }
    }
    ```

    1. `_authentication?.HasExpired` es `null` si nunca se ha autenticado, `true` si el token expiró, `false` si aún es válido.
    2. Token válido → retorna inmediatamente. Sin ninguna llamada HTTP al endpoint de Azure AD.
    3. `goto` comparte el bloque `TryAuthenticate` entre las ramas `true` y `null` sin duplicar código.
    4. Punto de entrada compartido para reautenticar. Llama a `Authenticate()` que hace el POST a Azure AD y actualiza `_authentication`.

=== "Flujo"

    ```text
    ¿Cuál es el estado actual de _authentication?
            │
            ├── HasExpired == false (token válido)
            │       → devuelve inmediatamente, no hace nada
            │
            ├── HasExpired == true (token caducado)
            │       → loguea "La autenticación ha caducado, reautenticando..."
            │       → salta a TryAuthenticate → llama a Authenticate()
            │
            └── null (primera llamada, nunca se ha autenticado)
                    → loguea "Autenticándose por primera vez..."
                    → salta a TryAuthenticate → llama a Authenticate()
    ```

### `Authenticate()`

**Firma:** `Task Authenticate()` (privado)

**Para qué sirve:** hacer la llamada HTTP real al endpoint de Azure AD para obtener un nuevo token.

```csharp
private async Task Authenticate()
{
    var request = new HttpRequestMessage(HttpMethod.Post, _authenticationConfig.Url);

    var collection = _authenticationConfig.ToKeyValuePairs();

    var content = new FormUrlEncodedContent(collection);
    request.Content = content;
    
    using var httpClient = new HttpClient();
    var response = await httpClient.SendAsync(request);
    string stringResponse = await response.Content.ReadAsStringAsync();

    if (!response.IsSuccessStatusCode)
    {
        throw new Exception($"Authentication error with code {response.StatusCode}! Response: {stringResponse}");
    }
    
    _authentication = JsonConvert.DeserializeObject<AuthenticationResponseModel>(stringResponse)!;
}
```

1. Construye una petición `POST` hacia la URL de Azure AD de `_authenticationConfig.Url`.
2. El cuerpo es `application/x-www-form-urlencoded` con los campos de `ToKeyValuePairs()` (client_id, client_secret, grant_type, resource, scope).
3. Si la respuesta no es 2xx, lanza una excepción con el código HTTP.
4. Si es correcta, deserializa la respuesta en `AuthenticationResponseModel` y la guarda en `_authentication`.

### `AuthenticationResponseModel.HasExpired`

**Para qué sirve:** propiedad calculada que indica si el token ha superado su tiempo de vida.

```csharp
public bool? HasExpired => string.IsNullOrEmpty(AccessToken)
    ? null
    : DateTimeOffset.FromUnixTimeSeconds(long.Parse(ExpiresOn)).DateTime < DateTime.UtcNow;
```

- Si no hay `AccessToken` → devuelve `null` (no autenticado nunca).
- Si hay token → convierte `ExpiresOn` (Unix timestamp en segundos) a `DateTime` y lo compara con `UtcNow`.

### `AuthenticationConfig.ToKeyValuePairs()`

**Para qué sirve:** convierte los datos de configuración en la lista de pares clave-valor que necesita `FormUrlEncodedContent`.

```csharp
public List<KeyValuePair<string, string>> ToKeyValuePairs() => new()
{
    new("client_id",     ClientId),
    new("client_secret", ClientSecret),
    new("grant_type",    GrantType),
    new("resource",      Resource),
    new("scope",         Scope)
};
```

---

## 4. ProvallianceService

**Fichero:** `Extractors/Services/ProvallianceService.cs`

Es el servicio que realiza las llamadas HTTP a la API de Provalliance. Se apoya en `ProvallianceAuthenticationHelperService` para obtener el token antes de cada petición.

### `PerformRequest<T>(HttpMethod method, string endpoint, string? body)`

**Firma:** `Task<T?> PerformRequest<T>(HttpMethod method, string endpoint, string? body = null)`

**Para qué sirve:** método genérico que ejecuta cualquier petición HTTP a la API de Provalliance. Todos los métodos públicos del servicio son envolturas de este.

```csharp
public async Task<T?> PerformRequest<T>(
    HttpMethod method,
    string endpoint,
    string? body = null)
{
    var request = new HttpRequestMessage(method, _baseUrl + endpoint);

    request.Headers.Authorization = await provallianceAuthenticationHelperService.BuildAuthenticationHeader();
    request.Headers.Add("Ocp-Apim-Subscription-Key", _subscriptionKey);

    if (body is not null)
    {
        logger.LogInformation("Enviando una solicitud con body: {RequestBody}", body);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
    }
    using var client = new HttpClient();
    client.Timeout = TimeSpan.FromMinutes(5);
    client.BaseAddress = new Uri(_baseUrl);
    client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

    var response = await client.SendAsync(request);
    response.EnsureSuccessStatusCode();

    var jsonResponse = await response.Content.ReadAsStringAsync();

    if (string.IsNullOrWhiteSpace(jsonResponse))
        return default;

    return JsonConvert.DeserializeObject<T>(jsonResponse);
}
```

1. Construye la URL completa con `_baseUrl + endpoint`.
2. Añade la cabecera `Authorization: Bearer <token>` obtenida de `BuildAuthenticationHeader()`.
3. Añade `Ocp-Apim-Subscription-Key` (identificador de suscripción de Azure API Management).
4. Si hay `body`, lo añade como JSON con `Content-Type: application/json`.
5. Crea un `HttpClient` con timeout de 5 minutos y envía la petición.
6. `EnsureSuccessStatusCode()` lanza excepción si la respuesta es 4xx o 5xx.
7. Si la respuesta está vacía devuelve `default`; si no, la deserializa como `T`.

### `GetStock()`

**Firma:** `Task<List<Stock>> GetStock()`

```csharp
public Task<List<Stock>> GetStock()
    => PerformRequest<List<Stock>>(HttpMethod.Get, "/stock/shopify").ShouldWontBeNull();
```

Llama a `PerformRequest` con el endpoint `/stock/shopify`. `.ShouldWontBeNull()` es una extensión de utilidad que lanza excepción descriptiva si el resultado es null, en lugar de propagar un `NullReferenceException` críptico más tarde.

### `GetClients()`

**Firma:** `Task<List<ClientResponseModel>> GetClients()`

```csharp
public async Task<List<ClientResponseModel>> GetClients()
{
    ClientResponseModelContainer? response = new ClientResponseModelContainer();
    List<ClientResponseModel> companys = new List<ClientResponseModel>();
    string endpoint = "/clients/client?PageNumber=0&PageItems=50";
    
    int pageNumber = 0;
    do
    {
        logger.LogDebug("Recuperando customers (página {num})...", pageNumber++);
        
        response = await PerformRequest<ClientResponseModelContainer>(
            HttpMethod.Get,
            endpoint
        );
        if (response.ClientsList != null)
        {
            companys.AddRange(response.ClientsList);
        }

        endpoint = response.NextPageLink.Substring(_baseUrl.Length);
    } while (response.ClientsList.Count == 50);

    return companys;
}
```

```text
Primera llamada:   GET /clients/client?PageNumber=0&PageItems=50  → 50 clientes
                   NextPageLink: "https://apim.../clients/client?PageNumber=1&PageItems=50"
                   endpoint ← quita la _baseUrl del principio → "/clients/client?PageNumber=1&PageItems=50"

Segunda llamada:   GET /clients/client?PageNumber=1&PageItems=50  → 50 clientes
                   ...

Tercera llamada:   GET /clients/client?PageNumber=2&PageItems=50  → 23 clientes (< 50 → fin del bucle)

Resultado:  123 clientes en total
```

El bucle se detiene cuando una página devuelve menos de 50 resultados — eso indica que es la última página.

### `PostOrder(OrderHeaderModel order)`

**Firma:** `Task<object?> PostOrder(OrderHeaderModel order)`

```csharp
public Task<object?> PostOrder(OrderHeaderModel order)
    => PerformRequest<object>(
        HttpMethod.Post,
        "/salesorders/shopify/b2b",
        JsonConvert.SerializeObject(new { order })
    );
```

Serializa el pedido como `{ "order": { ... } }` y lo envía con POST al endpoint `/salesorders/shopify/b2b`. La respuesta del ERP no se procesa.

---

## 5. ProductsWithImagesExtract — RunAsync

**Fichero:** `Extractors/ProductsWithImagesExtract.cs`

### `RunAsync(ActivityExecutionContext context)` — código completo

```csharp
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    _logger.LogInformation("Recuperando los productos del PIM");
    
    var salesLayerService = context.GetRequiredService<SalesLayerClientService>().GetService("CanalSalida");
    
    var response = await FuncUtils.WithCachedRun(() => salesLayerService.GetInfoAsync(), 
        "tmp/debug/provalliance/saleslayer", "salonspace", _logger);
    if (response.HasError)
    {
        throw new Exception($"Error al recuperar los productos de SalesLayer: {response.ErrorMessage}");
    }
    
    var data = response.Data.ToObject<SalonSpaceResponse>()!;
    
    _logger.LogInformation("Recuperados {numP} productos y {numC} categorías del PIM.",
        data.Products.Count, data.Categories.Count);
    
    // Los productos Visibles Y Obsoletos se consideran Invisibles
    data.Products
        .Where(x => x is { Obsoleto: true, Estatus: Estatus.Visible })
        .ForEach(x => x.Estatus = Estatus.Invisible);
    
    List<Product> products = [];
    
    // Productos sin CodigoAgrupacion → son productos simples (1 sola variante)
    foreach (var productoSimple in data.Products.Where(x => string.IsNullOrWhiteSpace(x.CodigoAgrupacion)))
    {
        var productOriginId = productoSimple.Sku;
        
        try
        {
            var product = new Product(productOriginId, [productoSimple]);
            products.Add(product);
        }
        catch (Exception e)
        {
            _logger.LogError(e, "Error al generar el producto simple con Id {id}.", productOriginId);
        }
    }
    
    // Productos con CodigoAgrupacion → se agrupan por ese código (N variantes por producto)
    foreach (var group in data.Products
        .Where(x => !string.IsNullOrWhiteSpace(x.CodigoAgrupacion))
        .GroupBy(x => x.CodigoAgrupacion))
    {
        var productOriginId = group.Key!;
        
        try
        {
            var product = new Product(productOriginId, group.Select(v => v).ToArray());
            products.Add(product);
        }
        catch (Exception e)
        {
            _logger.LogError(e, "Error al generar el producto con variantes para la agrupación {id}.", productOriginId);
        }
    }
    
    // Eliminar productos con OriginId duplicado (conservar solo el primero)
    var productsWithDuplicatedId = products
        .GroupBy(x => x.OriginId)
        .Where(x => x.Count() > 1)
        .SelectMany(x => x.Skip(1))
        .ToList();
    products.RemoveAll(x => productsWithDuplicatedId.Contains(x));
    productsWithDuplicatedId
        .GroupBy(x => x.OriginId)
        .ForEach(x => _logger.LogError(
            "El Id de origen {ref} está duplicado en {num} productos, se cogerá solamente el primero.",
            x.Key, x.Count() + 1));
    
    // Eliminar variantes duplicadas dentro de cada producto
    var variantsWithDuplicatedId = products
        .Select(x => (x.OriginId, DuplicatedVariants: x.RemoveDuplicatedVariants()))
        .ToList();
    variantsWithDuplicatedId
        .Where(x => x.DuplicatedVariants.Count > 0)
        .ForEach(x => _logger.LogError(
            "El producto con Id {ref} tenía {num} variantes duplicadas, se cogerá solamente la primera.",
            x.OriginId, x.DuplicatedVariants.Count + 1));
    
    ProductsOutput.Set(context, new Box<IProduct>(products.OfType<IProduct>().ToList()));
    
    var productsImages = products
        .SelectMany(x => x.GetParentImages()
            .Union(x.GetVariantsImages())
            .DistinctBy(i => i.ImageOriginId))
        .ToList();
    ProductsImagesOutput.Set(context, new Box<IProductImage>(productsImages));

    return new ActivityResult()
    {
        InformationLogs =
        [
            $"Recuperados {products.Count} productos del PIM con estados: " +
            $"{products.GroupBy(x => x.Status).Select(x => $"{x.Key} ({x.Count()})").Join(", ")}.",
            $"Recuperadas {products.Sum(x => x.GetVariants().Count)} variantes totales.",
            $"Recuperadas {productsImages.Count} imágenes."
        ]
    };
}
```

**Resumen de fases:**

| Fase | Qué hace |
|---|---|
| 1 | Obtiene datos de SalesLayer (con caché en desarrollo) |
| 2 | Marca como `Invisible` los productos `Visible + Obsoleto` |
| 3a | Crea `Product` para cada artículo sin `CodigoAgrupacion` (producto simple) |
| 3b | Agrupa por `CodigoAgrupacion` y crea `Product` con variantes |
| 4 | Elimina productos duplicados y variantes duplicadas dentro de cada producto |
| 5 | Emite `ProductsOutput` (productos) y `ProductsImagesOutput` (imágenes) |

---

## 6. Product — constructor y métodos

**Fichero:** `Extractors/Models/Product.cs`

### Constructor `Product(string originId, ICollection<SalonSpaceProduct> originalVariants)`

```csharp
public Product(string originId, ICollection<SalonSpaceProduct> originalVariants)
{
    OriginId = originId;
    
    var variants = originalVariants.Select(v => new Variant(this, v)).ToList();
    
    // Identificar la variante principal
    switch (variants.Count)
    {
        case 0:
            throw new ArgumentException("No variants are provided");
        case 1:
            _mainVariant = variants.Single();
            break;
        default:
        {
            var parentSkus = variants
                .Select(x => x.OriginObject.CodigoAgrupacion!)
                .Distinct()
                .ToList();
            if (parentSkus.Count > 1)
            {
                throw new ArgumentException("More than one parent sku has been provided");    
            }
        
            var parentSku = parentSkus.First();
            var mainVariant = variants.FirstOrDefault(x => x.OriginObject.CodigoAgrupacion == parentSku);

            _mainVariant = mainVariant ?? throw new ArgumentException("No variant with parentSku exists");
            break;
        }
    }
    _variants = variants;
    
    // Asignar opciones a las variantes
    if (_variants.Count == 1)
    {
        // Producto simple → siempre "Default Title" (convención de Shopify)
        _mainVariant.Options = new Dictionary<string, string>
        {
            { "Title", "Default Title" }
        };
    }
    else
    {
        // Producto con variantes → leer nombres de opciones del campo Agrupacion
        var optionsKeys = _mainVariant.OriginObject.Agrupacion.First()
            .Split('+')
            .Select(x => (pretty: x.Trim(), json: x.Trim().ToLower().Replace(" ", "_")))
            .ToList();
        
        foreach (var variant in _variants)
        {
            var options = new Dictionary<string, string>();
            foreach (var optionKey in optionsKeys)
            {
                var jsonValue = variant.OriginObject.GetValueByJsonPropertyName(optionKey.json)!;

                var value = jsonValue is Translatable<string> translatable
                    ? translatable.Get("es")
                    : jsonValue as string
                      ?? throw new NotImplementedException(
                          $"Estructura desconocida para la opción: {JsonConvert.SerializeObject(jsonValue)}");
                
                options.Add(optionKey.pretty, value);
            }
            variant.Options = options;
        }
    }
}
```

**Lo que hace paso a paso:**

1. Guarda el `OriginId` del producto.
2. Crea un objeto `Variant` por cada `SalonSpaceProduct`.
3. Identifica `_mainVariant`:
   - Si hay 1 variante, esa misma es la principal.
   - Si hay varias, busca la que tiene `CodigoAgrupacion` igual al `OriginId` del producto. Si hay más de un `CodigoAgrupacion` distinto, los datos son inconsistentes → excepción.
4. Asigna opciones:
   - Producto simple → `{"Title": "Default Title"}`.
   - Producto con variantes → lee `Agrupacion` del artículo padre (ej: `"Color + Talla"`), lo parte por `+`, y para cada variante busca el valor de cada opción por nombre de campo JSON.

### `GetVariants()`

```csharp
public ICollection<IVariant> GetVariants() => _variants.OfType<IVariant>().ToList();
```

Devuelve todas las variantes como interfaz `IVariant`. Los transformers y loaders usan esta interfaz para no depender del tipo concreto.

### `GetNumVariants()`

```csharp
public int GetNumVariants() => _variants.Count;
```

Atajo para obtener el número total de variantes del producto.

### `GetMainVariant()`

```csharp
public Variant GetMainVariant() => _mainVariant;
```

Devuelve la variante principal como tipo concreto `Variant` (no la interfaz), porque en algunos contextos se necesita acceder a `OriginObject` (el `SalonSpaceProduct` original).

### `GetVariantsImages()`

```csharp
public List<IProductImage> GetVariantsImages() => _variants
    .SelectMany(x => x.Images.Select(uri => new { VariantId = x.OriginId, ImageUri = uri }))
    .GroupBy(x => x.ImageUri)
    .Select(IProductImage (x) => new ProductImage
    {
        ProductOriginId = OriginId,
        ImageOriginId = x.Key.ToString(),
        ProductVariantsOriginId = x.Select(x => x.VariantId).ToList()
    }).ToList();
```

Extrae las imágenes propias de las variantes (`imagen_de_producto`). La agrupación por URL es clave: si la misma imagen aparece en varias variantes, se crea **un solo `ProductImage`** con todas las variantes listadas, en lugar de duplicar la imagen por cada variante.

### `GetParentImages()`

```csharp
public List<IProductImage> GetParentImages() => _mainVariant.OriginObject.ImagenesProductosAgrupados?
    .Select(x => x.Org)
    .GroupBy(x => x)
    .Select(IProductImage (x) => new ProductImage
    {
        ProductOriginId = OriginId,
        ImageOriginId = x.Key.ToString()!,
        ProductVariantsOriginId = []
    }).ToList() ?? [];
```

Extrae las imágenes del producto padre (`imagen_productos_agrupados`), que son compartidas por todas las variantes. El `ProductVariantsOriginId` vacío indica que la imagen pertenece al producto entero, no a una variante concreta.

### `GetSortedOptions()`

```csharp
public IDictionary<string, ICollection<string>> GetSortedOptions()
{
    var sortedOptions = new Dictionary<string, ICollection<string>>();
    
    var variantsOptions = _variants.Select(x => x.GetSelectedOptions()).ToList();
    foreach (var keys in _mainVariant.GetSelectedOptions().Keys)
    {
        var values = variantsOptions.Select(x => x[keys]).Distinct().ToList();
        sortedOptions.Add(keys, values);
    }
    return sortedOptions;
}
```

Devuelve todas las opciones del producto con todos sus valores posibles. Ejemplo de resultado:

```json
{
  "Color": ["Negro", "Blanco", "Rojo"],
  "Talla": ["S", "M", "L"]
}
```

El transformer de productos usa este diccionario para construir la estructura de opciones que espera la API de Shopify.

### `GetTags()`

```csharp
public HashSet<string> GetTags() => _variants
    .SelectMany(x => x.OriginObject.Etiqueta)
    .Distinct()
    .ToHashSet();
```

Recorre todas las variantes, une todos sus tags y elimina duplicados con `ToHashSet()`.

### `RemoveDuplicatedVariants()`

```csharp
private bool _removeDuplicatedVariantsAlreadyRan = false;

public List<Variant> RemoveDuplicatedVariants()
{
    if (_removeDuplicatedVariantsAlreadyRan)
    {
        throw new InvalidOperationException(
            $"{nameof(RemoveDuplicatedVariants)} ya se ejecutó en este producto!");
    }
    _removeDuplicatedVariantsAlreadyRan = true;
    
    var duplicatedVariants = _variants
        .GroupBy(x => x.OriginId)
        .Where(x => x.Count() > 1)
        .SelectMany(x => x.Skip(1))
        .ToList();
    duplicatedVariants.ForEach(x => _variants.Remove(x));

    return duplicatedVariants;
}
```

Detecta variantes con `OriginId` duplicado y elimina todas salvo la primera de cada grupo. Devuelve las eliminadas para que el llamador pueda loguearlo. El flag `_removeDuplicatedVariantsAlreadyRan` previene que se llame dos veces por accidente.

### `Status` — propiedad calculada

```csharp
public EntityStatus Status
{
    get
    {
        var variantsStatuses = _variants.Select(v => v.Status).Distinct().ToArray();
        
        if (variantsStatuses.Length == 1) return variantsStatuses[0];
        if (variantsStatuses.Contains(EntityStatus.Active)) return EntityStatus.Active;
        if (variantsStatuses.Contains(EntityStatus.Inactive)) return EntityStatus.Inactive;
        if (variantsStatuses.Contains(EntityStatus.Deleted)) return EntityStatus.Deleted;
        
        throw new IndexOutOfRangeException("Unhandled status");
    }
}
```

Calcula el estado del producto a partir de los estados de sus variantes:

```text
¿Todos con el mismo estado?  → ese estado
¿Alguna Active?              → Active
¿Alguna Inactive?            → Inactive
¿Alguna Deleted?             → Deleted
```

---

## 7. Variant — constructor y métodos

**Fichero:** `Extractors/Models/Product.cs` (al final del mismo fichero que `Product`)

### Constructor `Variant(Product parent, SalonSpaceProduct originObject)`

```csharp
public class Variant(Product parent, SalonSpaceProduct originObject) : IVariant
{
    public SalonSpaceProduct OriginObject { get; } = originObject;
    // ...
}
```

Es un constructor primario de C# 12. Guarda `parent` y `originObject` como campos implícitos accesibles desde los métodos de instancia. `parent` proporciona acceso al producto padre; `originObject` proporciona acceso a los datos originales de SalesLayer.

### `OriginId` — propiedad calculada

```csharp
public string OriginId => $"{parent.OriginId}#{OriginObject.Id}";
```

Genera el identificador único de la variante uniendo el `OriginId` del producto padre con el `Id` interno de SalesLayer, separados por `#`. Ejemplo: `"GHD001#12345"`. Este formato garantiza unicidad global.

### `Status` — propiedad calculada

```csharp
public EntityStatus Status => OriginObject.Estatus switch
{
    Estatus.Visible   => EntityStatus.Active,
    Estatus.Borrador  => EntityStatus.Inactive,
    Estatus.Invisible => EntityStatus.Deleted,
    _ => throw new ArgumentOutOfRangeException()
};
```

Convierte el `Estatus` del PIM al `EntityStatus` interno. Si aparece un valor no esperado, lanza excepción inmediatamente para que el problema sea visible.

### `GetSelectedOptions()`

```csharp
public IDictionary<string, string> GetSelectedOptions() =>
    Options
    ?? throw new InvalidOperationException(
        "No options set, please make sure this Variant has been added to a Product using its constructor first.");
```

Devuelve las opciones de esta variante. Lanza `InvalidOperationException` si se intenta acceder a las opciones antes de que el constructor de `Product` las haya asignado.

### `Images` — propiedad

```csharp
public List<Uri> Images => OriginObject.Imagenes?.Select(x => x.Org).ToList() ?? [];
```

Devuelve las URLs en alta resolución de las imágenes propias de esta variante (campo `imagen_de_producto` en SalesLayer).

### `GetParentImages()`

```csharp
public List<Uri> GetParentImages() => parent
    .GetParentImages()
    .Select(x => Uri.TryCreate(x.ImageOriginId, UriKind.Absolute, out var uri) ? uri : null)
    .DiscardNulls()
    .ToList();
```

Delega en `parent.GetParentImages()` y convierte los `ImageOriginId` (strings) de vuelta a `Uri`. Necesario cuando se quieren las imágenes del grupo desde el contexto de la variante en lugar del producto.

---

## 8. CustomerExtract — RunAsync

**Fichero:** `Extractors/CustomerExtract.cs`

### `RunAsync(ActivityExecutionContext context)` — código completo

```csharp
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    ProvallianceService service = context.GetRequiredService<ProvallianceService>();
    
    var clientes = await FuncUtils.WithCachedRun(() => service.GetClients(), 
        "tmp/debug/provalliance/middleware", "clientes", _logger);
    if (clientes.Count == 0)
    {
        throw new Exception("La lista de clientes está vacía o no se pudo recuperar.");
    }

    var leadPrefix = _configuration["ShopifyCredentials:LeadPrefix"].ShouldNotBeNull();
    clientes = clientes
        .Where(c => !c.OriginId.Trim().StartsWith(leadPrefix, StringComparison.OrdinalIgnoreCase))
        .ToList();
    
    foreach (var cliente in clientes)
    {
        foreach (var location in cliente.Locations)
        {
            location.LocationOriginId = cliente.OriginId + "#" + location.Codadr;
            location.Crn = cliente.Bprc1.Crn;
        }
    }
    
    int totalClientes = clientes.Count;
    clientes = clientes.Where(c => !string.IsNullOrWhiteSpace(c.OriginId)).ToList();
    
    _logger.LogInformation("Extracción finalizada. Clientes: {TotalClientes}", clientes.Count);
    var clientesDescartados = totalClientes - clientes.Count;
    if (clientesDescartados > 0)
    {
        _logger.LogWarning("Cantidad de clientes descartados: {clientesDescartados}", clientesDescartados);
    }

    Companies.Set(context, new Box<ICompany>(clientes.Cast<ICompany>().ToList()));

    return new ActivityResult
    {
        InformationLogs =
        [
            $"Recuperados {clientes.Count} clientes.",
        ]
    };
}
```

**Fases:**

| Fase | Qué hace |
|---|---|
| 1 | Llama a `GetClients()` (con caché en desarrollo) |
| 2 | Si la lista está vacía → lanza excepción (protección contra borrado masivo) |
| 3 | Filtra leads (por `LeadPrefix`) y asigna `LocationOriginId` y `Crn` a cada dirección |
| 4 | Descarta clientes sin `OriginId` y emite el output |

---

## 9. StockExtract — RunAsync

**Fichero:** `Extractors/StockExtract.cs`

### `RunAsync(ActivityExecutionContext context)` — código completo

```csharp
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    _logger.LogInformation("Recuperando el stock del middleware");

    var provallianceService = context.GetRequiredService<ProvallianceService>();

    var response = await FuncUtils.WithCachedRun(() => provallianceService.GetStock(), 
        "tmp/debug/provalliance/middleware", "stock", _logger);
    
    Output.Set(context, response);

    return new ActivityResult
    {
        InformationLogs =
        [
            $"Recuperados el stock de {response.Count} variantes del middleware."
        ]
    };
}
```

El extractor más sencillo: obtiene `ProvallianceService`, llama a `GetStock()` con caché, y emite la respuesta directamente sin ningún filtrado ni transformación.

---

## 10. LocalImagesExtractor — RunAsync

**Fichero:** `Extractors/PicsLocalExtractor.cs`

### `RunAsync(ActivityExecutionContext context)` — código completo

```csharp
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    var cfg = context.GetRequiredService<IConfiguration>().GetSection("FtpImages");

    var host             = cfg.GetValue<string>("Host")!;
    var port             = cfg.GetValue<int?>("Port") ?? 21;
    var user             = cfg.GetValue<string>("Username")!;
    var pass             = cfg.GetValue<string>("Password")!;
    var folders          = cfg.GetSection("RemoteFolders").Get<List<string>>() ?? new();
    var usePassive       = cfg.GetValue<bool?>("UsePassive") ?? true;
    var fileNameStartsWith = cfg.GetSection("FileNameStartsWith").Get<List<string>>() ?? new();

    var allFiles = new List<NasFile>();

    await using var client = new AsyncFtpClient(host, port);
    client.Credentials = new NetworkCredential(user, pass);
    client.Config.DataConnectionType = usePassive
        ? FtpDataConnectionType.AutoPassive
        : FtpDataConnectionType.AutoActive;

    await client.Connect();

    foreach (var folder in folders)
    {
        var items = await client.GetListing(folder, FtpListOption.Recursive);

        foreach (var item in items.Where(x => x.Type == FtpObjectType.File))
        {
            var fileName = item.Name;

            // Excluir el CSV que él mismo genera
            if (fileName.Equals("CSV_CargaImages.csv", StringComparison.OrdinalIgnoreCase))
                continue;

            // Excluir por prefijo si está configurado
            if (fileNameStartsWith.Count > 0 &&
                !fileNameStartsWith.Any(prefix =>
                    fileName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
                continue;

            // Parsear referencia y orden desde el nombre del fichero
            var nameNoExt = Path.GetFileNameWithoutExtension(fileName);
            var parts = nameNoExt.Split('-',
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            var orden     = parts.Length >= 2 ? parts[^1] : "0";
            var reference = parts.Length >= 2
                ? string.Join('-', parts.Take(parts.Length - 1))
                : nameNoExt;

            allFiles.Add(new NasFile
            {
                Name      = fileName,
                Folder    = Path.GetDirectoryName(item.FullName)!.Replace("\\", "/"),
                FullPath  = item.FullName,
                Reference = reference,
                Orden     = orden
            });
        }
    }

    var remoteFolder = folders.First();
    var csvRemotePath = $"{remoteFolder.TrimEnd('/')}/CSV_CargaImages.csv";

    var imageNames = allFiles
        .Select(x => x.Name)
        .Distinct()
        .OrderBy(x => x)
        .ToList();

    // La columna se llama "Imagen" para coincidir con el campo definido en SalesLayer
    var csvContent = "Imagen" + Environment.NewLine +
                     string.Join(Environment.NewLine, imageNames);

    await using var csvStream =
        new MemoryStream(System.Text.Encoding.UTF8.GetBytes(csvContent));

    await client.UploadStream(
        csvStream,
        csvRemotePath,
        FtpRemoteExists.Overwrite,
        createRemoteDir: true);

    Output.Set(context, new Box<NasFile>(allFiles));

    return new ActivityResult
    {
        InformationLogs =
        [
            $"Recuperadas {allFiles.Count} imágenes agrupadas en " +
            $"{allFiles.Select(x => x.Reference).Distinct().Count()} referencias."
        ]
    };
}
```

**Parseo del nombre de fichero:**

```text
"GHD-ALISADOR-PRO-3.jpg"
    └── GetFileNameWithoutExtension → "GHD-ALISADOR-PRO-3"
    └── Split('-')                  → ["GHD", "ALISADOR", "PRO", "3"]
    └── parts[^1]                   → "3"            (orden)
    └── Take(parts.Length - 1)      → "GHD-ALISADOR-PRO"  (referencia)
```

---

## 11. TranslationsExtract — InitInputs y RunAsync

**Fichero:** `Extractors/TranslationsExtract.cs`

### `InitInputs(ActivityExecutionContext context)`

```csharp
protected override void InitInputs(ActivityExecutionContext context)
{
    _productos = ProductosInput.Get(context).Property.ToList();
}
```

Lee la lista de `IProduct` que llega como input del workflow (producida por `ProductsWithImagesExtract`) y la guarda en `_productos`.

### `RunAsync(ActivityExecutionContext context)`

```csharp
protected override Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    List<ITranslatable> translations = _productos.OfType<ITranslatable>().ToList();
    TranslationsOutput.Set(context, translations);

    var result = new ActivityResult
    {
        InformationLogs =
        [
            $"Se han extraido {_productos.Count} productos para traducir",
            $"Se han extraido {translations.Count} recursos para traducir"
        ]
    };

    return Task.FromResult(result);
}
```

`OfType<ITranslatable>()` filtra la lista y devuelve solo los elementos que implementan la interfaz `ITranslatable`. Actualmente el tipo `Product` no la implementa, por lo que `translations` siempre está vacía. Es un punto de extensión preparado para la sincronización de traducciones.

---

## 12. ExtractTarifas — RunAsync (stub)

**Fichero:** `Extractors/PriceListExtract.cs`

### `RunAsync(ActivityExecutionContext context)`

```csharp
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    _logger.LogInformation("Extraer las tarifas");

    var transactionsService = context.GetRequiredService<TransactionsService>();

    PriceLists.Set(context, new Box<IPriceList>(new List<IPriceList>()));

    return new ActivityResult
    {
        InformationLogs =
        [
            // Comentarios de implementación pendiente eliminados
        ]
    };
}
```

El `transactionsService` se obtiene del contenedor pero nunca se usa. El único comportamiento real es emitir una lista vacía de `IPriceList`. Las tarifas se gestionan actualmente mediante `SyncPriceLists` en el workflow de Clientes.

---

## 13. ShopifyExtract — RunAsync (migración)

**Fichero:** `Extractors/Migration/ShopifyExtract.cs`

> **Estado:** permanentemente desactivado (`ShouldRunAsync() => false`). Este código nunca se ejecuta en el flujo normal.

### `RunAsync(ActivityExecutionContext context)` — código completo

```csharp
protected override async Task<ActivityResult> RunAsync(ActivityExecutionContext context)
{
    _logger.LogInformation("Recuperando los productos de Shopify");

    var shopifyWrapper = context.GetRequiredService<ShopifySDK.ShopifySDK>();
    var transactions = context.GetRequiredService<TransactionsService>();
    var products = await shopifyWrapper.Products.BulkGetAllWithVariantsExtended();

    TransactionsDbContext dbContext = await transactions.GetDbContext();

    List<Product> productsList = new List<Product>();
    List<ProductVariant> productVariants = new List<ProductVariant>();
    List<Metafield> metafields = new List<Metafield>();

    // Fase 1: clasificar los objetos por tipo leyendo el prefijo del ID
    products.ForEach(item => {
        try
        {
            JObject itemJobject = item as JObject;
            string idValue = itemJobject.First.First.Value<string>();
            _logger.LogDebug($"Conversión de elemento -> {idValue}");

            if (idValue.Contains("Variant"))
            {
                var itemObject = JsonConvert.DeserializeObject<ProductVariant>(item.ToString());
                productVariants.Add(itemObject);
            }
            else if (idValue.Contains("Product"))
            {
                var itemObject = JsonConvert.DeserializeObject<Product>(item.ToString());
                productsList.Add(itemObject);
            }

            if (idValue.Contains("Metafield"))
            {
                Metafield itemObject = JsonConvert.DeserializeObject<Metafield>(item.ToString());
                itemObject.Owner = itemJobject.Last.First.Value<string>();
                metafields.Add(itemObject);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError("Error al convertir elemento de respuesta de Shopify");
        }
    });

    // Fase 2: poblar productos en la BD de transacciones
    productsList.ForEach(productoSF => {
        try
        {
            var productoT = dbContext.Products
                .Include(x => x.Options)
                .FirstOrDefault(x => x.DestinoId.Equals(productoSF.Id));

            if (productoT == null)
            {
                // Nuevo producto: buscar su metafield originId
                Metafield? metafieldOrigen = metafields
                    .FirstOrDefault(x => x.Owner.Equals(productoSF.Id) && x.Key.Equals("originId"));

                if (metafieldOrigen != null)
                {
                    var newProducto = new ElsaShared.Data.Shopify.Product()
                    {
                        DestinoId = productoSF.Id!,
                        OrigenId  = metafieldOrigen.Value
                    };
                    newProducto.Options = productoSF.Options.Select(x => new ElsaShared.Data.Shopify.ProductOption()
                    {
                        Referencia = x.Name,
                        DestinoId  = x.Id!,
                        OrigenId   = $"{metafieldOrigen.Value}-{x.Name}",
                        Position   = x.Position == 0 ? 1 : x.Position
                    }).ToList();
                    dbContext.Products.Add(newProducto);
                    dbContext.SaveChanges();
                }
                else
                {
                    _logger.LogWarning($"No existe metafield origenId para el producto: {productoSF?.Id}");
                }
            }
            else
            {
                // Producto ya existente: sincronizar opciones
                var optionsShopify = productoSF.Options.Select(x => new ElsaShared.Data.Shopify.ProductOption()
                {
                    Referencia = x.Name,
                    DestinoId  = x.Id!,
                    OrigenId   = $"{productoT.OrigenId}-{x.Name}",
                    Position   = x.Position == 0 ? 1 : x.Position
                }).ToList();

                bool isChanges = false;
                optionsShopify.ForEach(option => {
                    if (!productoT.Options.Any(x => x.DestinoId == option.DestinoId))
                    {
                        option.Product = productoT;
                        dbContext.ProductOptions.Add(option);
                        isChanges = true;
                    }
                });
                if (isChanges) dbContext.SaveChanges();

                isChanges = false;
                productoT.Options.ForEach(option => {
                    if (!optionsShopify.Any(x => x.DestinoId == option.DestinoId))
                    {
                        dbContext.Entry(option).State = EntityState.Deleted;
                        isChanges = true;
                    }
                });
                if (isChanges) dbContext.SaveChanges();
            }
        }
        catch (Exception ex)
        {
            _logger.LogError($"Error al crear producto {productoSF.Id} en Transaction");
        }
    });

    // Fase 3: poblar variantes en la BD de transacciones
    productVariants.ForEach(variantSF => {
        try
        {
            var variantT = dbContext.Variants
                .FirstOrDefault(x => x.DestinoId.Equals(variantSF.Id));

            if (variantT == null)
            {
                Metafield? metafieldOrigen = metafields
                    .FirstOrDefault(x => x.Owner.Equals(variantSF.Id) && x.Key.Equals("originId"));
                var productoT = dbContext.Products
                    .Include(x => x.Variants)
                    .FirstOrDefault(x => x.DestinoId.Equals(variantSF.Product.Id));

                if (metafieldOrigen != null && productoT != null)
                {
                    var newVariant = new ElsaShared.Data.Shopify.Variant()
                    {
                        DestinoId              = variantSF.Id!,
                        OrigenId               = metafieldOrigen.Value,
                        ShopifyInventoryItemId = variantSF.InventoryItem.Id!,
                        ProductId              = productoT.Id
                    };
                    dbContext.Variants.AddAsync(newVariant);
                    dbContext.SaveChanges();
                }
                else
                {
                    if (metafieldOrigen == null)
                    {
                        _logger.LogWarning(
                            $"No existe metafield origenId para la variante: {variantSF.Id}");
                        if (productoT is not null && !productoT.Variants.Any(x => x.Referencia == "$"))
                        {
                            // Crear variante centinela si no existe
                            var newVariant = new ElsaShared.Data.Shopify.Variant()
                            {
                                DestinoId              = variantSF.Id!,
                                OrigenId               = productoT.DestinoId + "-$",
                                Referencia             = "$",
                                ShopifyInventoryItemId = variantSF.InventoryItem.Id!,
                                ProductId              = productoT.Id
                            };
                            dbContext.Variants.AddAsync(newVariant);
                            dbContext.SaveChanges();
                        }
                    }
                    if (productoT == null)
                        _logger.LogWarning(
                            $"No existe producto en Transaction para la variante: {variantSF.Id}");
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError($"Error al crear variante {variantSF.Id} en Transaction");
        }
    });

    return new()
    {
        InformationLogs =
        [
            $"Recuperados {products.Count} productos de Shopify."
        ]
    };
}
```

---

## 14. ClientResponseModel — métodos de ICompany

**Fichero:** `Extractors/Models/ClientResponseModel.cs`

`ClientResponseModel` implementa la interfaz `ICompany`. Estos métodos son los que llaman los transformers y loaders para trabajar con clientes de forma agnóstica al origen de los datos.

### `OriginId`

```csharp
public string OriginId => Company.CodCom;
```

El identificador único de la empresa es el campo `BPCNUM` (`CodCom`) del bloque `BPC0_1`. Es el código de cliente en el ERP (Sage X3).

### `GetLocations()`

```csharp
public ICollection<ILocation> GetLocations()
{
    return new List<ILocation>(Locations);
}
```

Devuelve el array de `LocationResponseModel` casteado como `ILocation`. Cada dirección del cliente es una sucursal (`CompanyLocation`) en Shopify B2B.

### `GetCustomers()`

```csharp
public ICollection<ICustomer> GetCustomers()
{
    return new List<ICustomer>(Locations);
}
```

Devuelve el mismo array de `LocationResponseModel` pero casteado como `ICustomer`. La misma dirección actúa a la vez como sucursal y como contacto de acceso — ver sección 15 para entender cómo `LocationResponseModel` implementa ambas interfaces.

### `GetMainContact()`

```csharp
public ICustomer? GetMainContact()
{
    return Locations.First();
}
```

Devuelve la primera dirección como contacto principal de la empresa. En el modelo de Shopify B2B, el contacto principal es el que tiene permisos de administrador sobre la `Company`.

### `GetFiscalZone()`

```csharp
public string GetFiscalZone()
{
    return ZonaFiscal.zonaFiscal;
}
```

Devuelve el código de zona fiscal del cliente (`VACBPR` del bloque `BPC3_2`). Se guarda como metafield `upng.zona_fiscal` en la `Company` de Shopify. Valores posibles: `EXE` (exento), `es_re:REQ` (recargo de equivalencia), cualquier otro valor (régimen normal).

### `GetPriceListsIds()`

```csharp
public IDictionary<string, ICollection<string>> GetPriceListsIds()
{
    return new Dictionary<string, ICollection<string>>();
}
```

Devuelve siempre un diccionario vacío. Las tarifas de precio no se extraen desde `ClientResponseModel` — se gestionan en el workflow de Clientes mediante las actividades `SyncPriceLists`.

---

## 15. LocationResponseModel — métodos de ILocation e ICustomer

**Fichero:** `Extractors/Models/ClientResponseModel.cs` (misma clase)

`LocationResponseModel` es una clase que implementa **a la vez** `ILocation` y `ICustomer`. Esto es porque en el modelo de Shopify B2B, cada dirección de un cliente corresponde tanto a una sucursal (`CompanyLocation`) como a un contacto (`Customer`) con acceso a esa sucursal.

### `Email` — setter con normalización

```csharp
private string _email = string.Empty;

[JsonProperty("WEB1")]
public string Email
{
    get => _email;
    set => _email = (value ?? string.Empty).Trim().ToLowerInvariant();
}
```

El setter normaliza el email: elimina espacios al principio y al final, y lo convierte a minúsculas. Esto es fundamental porque el email es el `OriginId` del contacto en Shopify — si el mismo email llega con mayúsculas en un registro y minúsculas en otro, el sistema los trataría como contactos distintos.

### `ILocation.OriginId` y `ICustomer.OriginId` — implementación explícita

```csharp
public string LocationOriginId { get; set; }

string ILocation.OriginId => LocationOriginId;
// Valor: "{CodCliente}#{CodDireccion}"  →  ej: "C0001#DIR01"
// Asignado en CustomerExtract.RunAsync

string ICustomer.OriginId => Email;
// Valor: el email normalizado  →  ej: "contacto@peluqueria.com"
```

La implementación explícita de interfaz (con el prefijo `ILocation.` e `ICustomer.`) significa que el mismo campo `OriginId` devuelve cosas distintas según la interfaz con la que se accede al objeto.

### `Status`

```csharp
public EntityStatus Status
{
    get { return EntityStatus.Active; }
}
```

Devuelve siempre `Active`. Las direcciones del ERP no tienen un estado propio — el estado se hereda de la empresa. Si una empresa se archiva, todas sus direcciones quedan inaccesibles.

### `GetCustomers()` en `LocationResponseModel`

```csharp
public ICollection<ICustomer> GetCustomers()
{
    return new List<ICustomer>() { this };
}
```

Cuando se accede a la lista de contactos desde una dirección, devuelve una lista con ella misma (la propia dirección es también el contacto).

### `GetPriceListsIds()` en `LocationResponseModel`

```csharp
public ICollection<string> GetPriceListsIds()
{
    return new List<string>();
}
```

Devuelve siempre una lista vacía. Las tarifas se asignan a nivel de `CompanyLocation` en Shopify mediante las actividades `SyncPriceLists`.

---

## 16. Orders.Retrieve — ShopifySDK

**Fichero:** `Comunes/UPG.ShopifySDK/Services/Orders.cs`
**Proyecto:** `UPG.ShopifySDK` (proyecto compartido, externo a este repo)

Este método es el que usa el extractor de pedidos (`OrdersExtractor`) para obtener pedidos de Shopify.

### `Retrieve(string query, ...)`

```csharp
public async Task<List<Order>> Retrieve(
    string query,
    uint ordersPageSize = 250,
    uint lineItemsPageSize = 250,
    int lineItemsWorkers = 6,
    int channelCapacity = 200,
    CancellationToken ct = default)
{
    _logger.LogInformation(
        "Recuperando los pedidos de Shopify que coincidan con la siguiente query: {query}", query);
    
    // Cola paralela limitada para no desbordar memoria con miles de pedidos
    var channel = System.Threading.Channels.Channel.CreateBounded<Order>(
        new BoundedChannelOptions(channelCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleWriter = true,
            SingleReader = false
        });

    // Productor: descarga páginas de pedidos y los encola
    Exception? producerError = null;
    var producer = Task.Run(async () =>
    {
        try
        {
            string? afterCursor = null;
            OrderConnection? graphResult;

            do
            {
                ct.ThrowIfCancellationRequested();

                var graphRequest = new GraphRequest
                {
                    Query = ShopifySDK.ReadQueryFromFileSystem("Orders"),
                    Variables = new Dictionary<string, object>
                    {
                        {"first", ordersPageSize},
                        {"query", query}
                    }
                };

                if (afterCursor is not null)
                    graphRequest.Variables.Add("after", afterCursor);

                graphResult = await shopifySdk.PerformGraphRequest<OrderConnection>(
                    GraphServiceMultiTokenPool.AcquireReason.Query,
                    graphRequest,
                    "Orders"
                );

                foreach (var order in graphResult.Nodes)
                    await channel.Writer.WriteAsync(order, ct);

                afterCursor = graphResult.PageInfo.EndCursor;

            } while (graphResult?.PageInfo?.HasNextPage == true);
        }
        catch (Exception ex)
        {
            producerError = ex;
            throw;
        }
        finally
        {
            // Señal de fin: ya no habrá más pedidos en la cola
            channel.Writer.TryComplete(producerError);
        }
    }, ct);
    
    // Consumidores paralelos: recuperan las líneas de cada pedido
    var results = new ConcurrentBag<Order>();
    var workers = new List<Task>(lineItemsWorkers);
    for (int i = 0; i < lineItemsWorkers; i++)
    {
        workers.Add(Task.Run(async () =>
        {
            await foreach (var order in channel.Reader.ReadAllAsync(ct))
            {
                var lines = await RetrieveAllLineItems(order.Id!, lineItemsPageSize);
                order.LineItems = new LineItemConnection { Nodes = lines };
                results.Add(order);
            }
        }, ct));
    }

    await producer;
    await Task.WhenAll(workers);

    var orders = results.ToList();
    _logger.LogInformation("Recuperados {num} pedidos de Shopify.", orders.Count);
    return orders;
}
```

**Arquitectura productor-consumidor:**

El método usa un `Channel<Order>` (cola en memoria con límite) para separar la descarga de pedidos de la descarga de sus líneas:

```text
Productor (1 task)
  │  Descarga páginas de pedidos de Shopify (GraphQL, paginado con cursor)
  │  Encola cada Order conforme llega
  │
  ▼
Channel<Order> (cola con límite de 200 → bloquea si está llena)
  │
  ▼
Consumidores (6 tasks en paralelo)
  │  Leen Orders de la cola
  │  Para cada Order, llaman a RetrieveAllLineItems()
  │  Añaden el Order enriquecido a ConcurrentBag<Order>
```

**Por qué esta arquitectura:** la descarga de líneas de pedido es la operación más lenta (requiere una petición adicional por pedido). Con 6 workers en paralelo se multiplica el throughput sin saturar la API de Shopify.

**El parámetro `query`:** es la query de la API de Shopify tal como está configurada en `appsettings.json` bajo `FilterOrders:query`. En este proyecto: `tag_not:Sincronizado`.

---

## 17. GetCompanyDetailsForCustomer — ShopifySDK

**Fichero:** `Comunes/UPG.ShopifySDK/Utils/OrderUtils.cs`
**Proyecto:** `UPG.ShopifySDK` (proyecto compartido, externo a este repo)

Es un método de extensión sobre `Order`. Se usa en `OrderTransform` para extraer el `ExternalId` del cliente del ERP desde el pedido de Shopify.

### `GetCompanyDetailsForCustomer(this Order order)`

```csharp
public static PurchasingCompany? GetCompanyDetailsForCustomer(this Order order)
{
    if (order?.PurchasingEntity == null)
        return null;

    var json = order.PurchasingEntity.ToString();
    if (string.IsNullOrWhiteSpace(json))
        return null;

    try
    {
        var token = JToken.Parse(json);
        if (token is not JObject obj)
            return null;

        if (!obj.ContainsKey("company") || !obj.ContainsKey("location"))
            return null;

        return obj.ToObject<PurchasingCompany>();
    }
    catch (JsonException)
    {
        return null;
    }
}
```

**Por qué existe:** el campo `PurchasingEntity` de un `Order` de Shopify B2B es un tipo polimórfico — puede ser una `Company` (pedido B2B) o un `Customer` individual. Para distinguirlo sin romper la deserialización, el SDK lo trata como `object` y este método lo inspecciona manualmente.

**Qué hace paso a paso:**

1. Si `PurchasingEntity` es null, devuelve null (no es un pedido B2B).
2. Convierte `PurchasingEntity` a string JSON y lo parsea como `JToken`.
3. Verifica que el JSON contenga los campos `"company"` y `"location"` — si no, no es un pedido de empresa.
4. Deserializa a `PurchasingCompany`, que tiene:
   - `Company.ExternalId` → el `OriginId` del cliente en el ERP (el `CodCom`)
   - `Location` → la sucursal desde la que se hizo el pedido

**Cómo se usa en `OrderTransform`:**

```csharp
var company = order.GetCompanyDetailsForCustomer()?.Company;
var customerId = company?.ExternalId;   // ← CodCom del ERP
if (string.IsNullOrWhiteSpace(customerId))
    return null;  // descarta el pedido si no tiene ExternalId
```

Si un pedido no tiene `ExternalId` (porque la empresa no está sincronizada o el pedido fue creado manualmente sin ligar a una Company), se descarta y se loguea como advertencia.

---

## 18. BulkGetAllWithVariantsExtended — ShopifySDK

**Fichero:** `Comunes/UPG.ShopifySDK/Services/Products/Products.cs`
**Proyecto:** `UPG.ShopifySDK` (proyecto compartido, externo a este repo)

Solo lo usa `ShopifyExtract` (la herramienta de migración, desactivada).

### `BulkGetAllWithVariantsExtended(bool includeMetafields = true)`

```csharp
public Task<ICollection<dynamic?>> BulkGetAllWithVariantsExtended(bool includeMetafields = true)
    => includeMetafields
        ? shopifySdk.Bulk.Run<dynamic>("AllProductsVariantsExtended")
        : shopifySdk.Bulk.Run<dynamic>("AllProductsVariantsExtendedWithoutMetafields");
```

Lanza una operación **Bulk Query** de Shopify. Las Bulk Queries son un mecanismo especial de la API de Shopify para descargar grandes volúmenes de datos de una sola vez, sin las limitaciones de paginación de las queries normales.

**Cómo funciona una Bulk Query de Shopify:**

```text
1. Se envía una mutación GraphQL que lanza el proceso de exportación en los servidores de Shopify
2. Shopify procesa la query en background (puede tardar minutos)
3. Cuando termina, genera un fichero JSONL con todos los resultados
4. El SDK descarga ese fichero y lo parsea línea a línea
5. Cada línea es un objeto JSON independiente (producto, variante o metafield)
```

**Por qué devuelve `dynamic?`:** la Bulk Query mezcla en el mismo stream varios tipos de objetos (productos, variantes, metafields). En lugar de un único tipo fuertemente tipado, devuelve `dynamic` para que el llamador pueda clasificar cada objeto inspeccionando su campo `id`.

**La query `AllProductsVariantsExtended`** está definida como un fichero `.graphql` en el proyecto ShopifySDK. Descarga:
- Todos los productos con sus opciones
- Todas las variantes con su `InventoryItem.Id`
- Los metafields `originId` de cada producto y variante (si `includeMetafields = true`)

---

## Resumen: qué método hace qué

| Clase | Método | Lo que hace en una línea |
|---|---|---|
| `BaseActivity<T>` | `InitInputs` | Lee los inputs del workflow antes de ejecutar |
| `BaseActivity<T>` | `ShouldRunAsync` | Decide si la actividad corre (`true`) o se salta (`false`) |
| `BaseActivity<T>` | `RunAsync` | Lógica principal de la actividad |
| `FuncUtils` | `WithCachedRun` | Envuelve una llamada a API con caché en disco para desarrollo |
| `ProvallianceAuthenticationHelperService` | `BuildAuthenticationHeader` | Devuelve la cabecera Bearer lista para usar |
| `ProvallianceAuthenticationHelperService` | `EnsureIsAuthenticated` | Garantiza que hay un token válido (renueva si ha caducado) |
| `ProvallianceAuthenticationHelperService` | `Authenticate` | Hace el POST a Azure AD y guarda el token recibido |
| `AuthenticationResponseModel` | `HasExpired` | Comprueba si el token ha superado su tiempo de expiración |
| `AuthenticationConfig` | `ToKeyValuePairs` | Convierte la config a la lista que necesita `FormUrlEncodedContent` |
| `ProvallianceService` | `PerformRequest<T>` | Ejecuta cualquier petición HTTP a la API de Provalliance |
| `ProvallianceService` | `GetStock` | Llama a `/stock/shopify` y devuelve la lista de stock |
| `ProvallianceService` | `GetClients` | Llama a `/clients/client` con paginación automática |
| `ProvallianceService` | `PostOrder` | Envía un pedido al ERP vía POST |
| `ProductsWithImagesExtract` | `RunAsync` | Extrae productos del PIM, los agrupa, limpia duplicados y emite 2 outputs |
| `Product` | constructor | Crea el producto, identifica variante principal y asigna opciones |
| `Product` | `GetVariants` | Devuelve todas las variantes como interfaz |
| `Product` | `GetNumVariants` | Devuelve el número de variantes |
| `Product` | `GetMainVariant` | Devuelve la variante principal (con datos del artículo padre del PIM) |
| `Product` | `GetVariantsImages` | Extrae imágenes propias de variantes, agrupadas por URL |
| `Product` | `GetParentImages` | Extrae imágenes del producto padre (compartidas por todas las variantes) |
| `Product` | `GetSortedOptions` | Devuelve todas las opciones con todos sus valores posibles |
| `Product` | `GetTags` | Devuelve el conjunto unificado de tags de todas las variantes |
| `Product` | `RemoveDuplicatedVariants` | Elimina variantes con `OriginId` duplicado; ejecutable solo una vez |
| `Product` | `Status` | Calcula el estado del producto según las variantes (prioriza Active) |
| `Variant` | constructor | Crea la variante ligada a su producto padre |
| `Variant` | `OriginId` | Genera el ID compuesto `{ProductOriginId}#{SalesLayerId}` |
| `Variant` | `Status` | Convierte `Estatus` del PIM a `EntityStatus` interno |
| `Variant` | `GetSelectedOptions` | Devuelve las opciones de esta variante (lanza error si no se asignaron) |
| `Variant` | `Images` | Devuelve las imágenes propias de esta variante |
| `Variant` | `GetParentImages` | Devuelve las imágenes del producto padre desde el contexto de la variante |
| `CustomerExtract` | `RunAsync` | Extrae clientes, filtra leads, enriquece LocationOriginId y Crn |
| `StockExtract` | `RunAsync` | Extrae stock del ERP y lo emite sin modificaciones |
| `LocalImagesExtractor` | `RunAsync` | Lista ficheros del FTP, parsea referencias/orden, genera y sube CSV |
| `TranslationsExtract` | `InitInputs` | Lee la lista de productos del input del workflow |
| `TranslationsExtract` | `RunAsync` | Filtra los productos que implementan `ITranslatable` |
| `ExtractTarifas` | `RunAsync` | Emite siempre una lista vacía (stub sin implementar) |
| `ShopifyExtract` | `RunAsync` | Descarga Shopify bulk y puebla la BD de transacciones (migración) |
| `ClientResponseModel` | `OriginId` | Devuelve `Company.CodCom` como identificador de la empresa |
| `ClientResponseModel` | `GetLocations` | Devuelve las direcciones del cliente como `ILocation` |
| `ClientResponseModel` | `GetCustomers` | Devuelve las direcciones del cliente como `ICustomer` |
| `ClientResponseModel` | `GetMainContact` | Devuelve la primera dirección como contacto principal |
| `ClientResponseModel` | `GetFiscalZone` | Devuelve el código de zona fiscal del cliente |
| `ClientResponseModel` | `GetPriceListsIds` | Devuelve siempre vacío (tarifas gestionadas por SyncPriceLists) |
| `LocationResponseModel` | `Email` setter | Normaliza el email: trim + lowercase |
| `LocationResponseModel` | `ILocation.OriginId` | Devuelve `LocationOriginId` (`{CodCliente}#{CodDireccion}`) |
| `LocationResponseModel` | `ICustomer.OriginId` | Devuelve `Email` (el email como ID del contacto) |
| `LocationResponseModel` | `GetCustomers` | Se devuelve a sí misma como lista de un elemento |
| `LocationResponseModel` | `GetPriceListsIds` | Devuelve siempre vacío |
| `Orders` (SDK) | `Retrieve` | Descarga pedidos con arquitectura productor-consumidor paralela |
| `OrderUtils` (SDK) | `GetCompanyDetailsForCustomer` | Extrae la Company B2B del campo polimórfico `PurchasingEntity` |
| `Products` (SDK) | `BulkGetAllWithVariantsExtended` | Lanza una Bulk Query para descargar todos los productos+variantes+metafields |
