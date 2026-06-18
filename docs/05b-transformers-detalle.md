# 05b — Transformers: detalle completo

Este documento entra en profundidad en cada transformer: qué campos mapea exactamente, qué lógica aplica, qué metafields genera y cómo resuelve los IDs de Shopify.

---

## Transformer 1 — Crear productos (`ProductsCreateTransform`)

### Qué recibe

```csharp
[Input] Box<IProduct>  ProductosCrearInput    // productos nuevos a crear en Shopify
[Input] Box<IVariant>  VariantesCrearInput    // variantes nuevas de productos ya existentes
```

Distingue dos escenarios:
- **Producto nuevo completo**: el producto padre no existe aún en Shopify. Se crea el producto con todas sus variantes en una sola operación.
- **Variante nueva en producto existente**: el producto padre ya existe en Shopify. Solo se añaden las variantes nuevas.

### Qué produce

```csharp
ProductsWithVariantsCreateLoaderInput
{
    Products  = List<(OriginInput<ProductCreateInput>, OriginInput<ProductVariantsBulkInput>[])>
    Variants  = Dictionary<string shopifyProductId, OriginInput<ProductVariantsBulkInput>[]>
    PublishProducts = true
    ExcludeNewProductsFromMarkets = false
}
```

### El `OriginInput<T>`

Todas las listas de este transformer usan el tipo `OriginInput<T>`, que es un contenedor que agrupa el input de Shopify con su `OriginId` (para que el loader pueda registrarlo en la BD de transacciones una vez creado):

```csharp
class OriginInput<T>
{
    string OriginId    // el código del ERP/PIM
    string? Reference  // en variantes: el SKU del artículo
    T Input            // el input para la API de Shopify
}
```

### Cómo se mapea `Product → ProductCreateInput`

El perfil `ProductosMappingTransforms` define este mapeo:

| Campo de Shopify | Lógica del mapeo |
|---|---|
| `Title` | Si tiene múltiples variantes: usa `ParentProductName.Get("es")`; si es simple: `NombreProducto.Get("es")` |
| `DescriptionHtml` | `LongProductDescription.Get("es")` de la variante principal |
| `Handle` | Para multi-variante: `ParentUrlSeo`; para simple: `UrlSeo` del artículo |
| `Status` | `Active→ACTIVE`, `Inactive→DRAFT`, `Deleted→ARCHIVED` |
| `Tags` | Lista de strings de `etiqueta`, limpiados y deduplicados |
| `Vendor` | Primer elemento del array `Brand` |
| `Seo.Title` | Para multi-variante: `ParentMetatitle`; para simple: `MetaTitle.Get("es")` |
| `Seo.Description` | Para multi-variante: `ParentMetadescription`; para simple: `MetaDescription.Get("es")` |
| `ProductOptions` | Opciones construidas desde `GetSortedOptions()` del producto |
| `Metafields` | Ver lista completa abajo |

#### Metafields del producto

Se generan de forma automática en `GetMetafieldsProducto`. Los metafields vacíos (valor `null` o `""`) se omiten.

| Namespace | Key | Tipo | Valor |
|---|---|---|---|
| `upng` | `originId` | `single_line_text_field` | `OriginId` del producto |
| `upng` | `referencia` | `single_line_text_field` | Mismo valor que `originId` |
| `upng` | `last_sync` | `single_line_text_field` | Fecha y hora actual `"dd-MM-yyyy HH:mm"` |
| `product` | `is_discontinued` | `boolean` | `"true"` o `"false"` según campo `Obsoleto` |
| `product_info` | `prod_ss_description_short` | `multi_line_text_field` | `ShortProductDescription.Get("es")` |
| `product_info` | `more_details` | `multi_line_text_field` | `AdditionalBenefits.Get("es")` |
| `product_info` | `prod_ingredients` | `multi_line_text_field` | `Ingredients.Get("es")` |
| `product_info` | `prod_ss_instructions` | `multi_line_text_field` | `HowToUse.Get("es")` |
| `brand` | `prod_brand` | `single_line_text_field` | Primer elemento de `Brand` |
| `upng` | `shopify_line_brand` | `single_line_text_field` | `ShopifyLineaMarca` |
| `upng` | `shopify_category` | `single_line_text_field` | `ShopifyCategory` |
| `upng` | `shopify_subcategory` | `single_line_text_field` | `ShopifySubcategory` |
| `upng` | `benefits` | `multi_line_text_field` | `Benefits.Get("es")` |
| `upng` | `key_features` | `multi_line_text_field` | `KeyFeatures.Get("es")` |
| `upng` | `warranties_and_certifications` | `multi_line_text_field` | `WarrantiesAndCertifications` |
| `upng` | `safety_warning_content` | `multi_line_text_field` | `SafetyWarningContent` |
| `upng` | `brand_line` | `single_line_text_field` | `BrandLine` |
| `upng` | `brand_family` | `single_line_text_field` | `BrandFamily` |
| `upng` | `brand_subfamily` | `single_line_text_field` | `BrandSubfamily` |
| `upng` | `product_class` | `list.single_line_text_field` | JSON de `ProductClass` |
| `upng` | `target_gender` | `list.single_line_text_field` | JSON de `TargetGender` |
| `upng` | `hair_need` | `list.single_line_text_field` | JSON de `HairNeed` |
| `upng` | `category_name` | `single_line_text_field` | `CategoryName` |
| `upng` | `descargar_ficha_tecnica` | `url` | `FichaTecnica` |
| `upng` | `tax-class` | `single_line_text_field` | `"21"` si `NivelImpuesto=NOR`, `"10"` si `RED`, `"4"` si `SRD`. **Lanza excepción si no es ninguno de estos** |
| `custom` | `filtro_*` | `single_line_text_field` | ~40 campos de filtros de categoría (tintes, styling, depilación, accesorios, etc.) |

> El metafield `tax-class` es especial: está fuera del bloque try/catch a propósito. Si un producto tiene un `NivelImpuesto` desconocido, la transformación del producto **falla completamente**. Esto garantiza que nunca se suba un producto sin tipo de IVA definido.

#### Metafields de la variante

Definidos en `GetMetafieldsVariante`:

| Namespace | Key | Tipo | Valor |
|---|---|---|---|
| `upng` | `originId` | `single_line_text_field` | `OriginId` de la variante |
| `upng` | `tags_shopify` | `list.single_line_text_field` | JSON de `Etiqueta` |
| `upng` | `benefits` | `multi_line_text_field` | `Benefits.Get("es")` |
| `product_info` | `more_details` | `multi_line_text_field` | `AdditionalBenefits.Get("es")` |
| `upng` | `key_features` | `multi_line_text_field` | `KeyFeatures.Get("es")` |
| `product_info` | `prod_ss_instructions` | `multi_line_text_field` | `HowToUse.Get("es")` |
| `upng` | `ean_1` | `single_line_text_field` | `Ean1` |
| `upng` | `ean_2` | `single_line_text_field` | `Ean2` |
| `upng` | `ean_3` | `single_line_text_field` | `Ean3` |
| `upng` | `hair_type` | `single_line_text_field` | `HairType.Get("es")` |
| `upng` | `hair_need` | `list.single_line_text_field` | JSON de `HairNeed` |
| `upng` | `content_type` | `single_line_text_field` | Primer elemento de `ContentType` |
| `upng` | `content_value` | `integer` | `ContentValue` |
| `upng` | `color` | `single_line_text_field` | `Color.Get("es")` |
| `upng` | `units_per_box` | `integer` | `UnitsPerBox` (parseado a entero) |
| `upng` | `weight` | `decimal` | `Weight` (parseado, coma→punto) |
| `upng` | `PVP` | `decimal` | `SalonSpaceSellingPrice` |
| `upng` | `special_selling_price` | `decimal` | `SalonSpaceSpecialSellingPrice` |
| `variant` | `codigo_agrupacion` | `single_line_text_field` | `CodigoAgrupacion` |
| `upng` | `galeria_imagenes` | `list.file_reference` | JSON de IDs de medias de Shopify |
| `upng` | `pack_profesionales` | `list.variant_reference` | JSON de IDs de variantes del pack |

> `galeria_imagenes` solo tiene valor en la actualización (ProductsUpdateTransform), porque las imágenes deben existir antes en Shopify para tener un ID. En la creación, este metafield se envía vacío.

#### Campos directos de la variante

| Campo Shopify | Valor |
|---|---|
| `Price` | `SalonSpaceSellingPrice` (parseado a decimal, coma→punto) |
| `Barcode` | `Ean` (EAN principal; null si vacío) |
| `InventoryItem.Sku` | `Sku` del artículo |
| `InventoryItem.Tracked` | `true` si `SkuType` contiene "material"; `false` si contiene "digital" |
| `InventoryItem.RequiresShipping` | Mismo valor que `Tracked` |
| `OptionValues` | Lista de `{OptionName, Name}` de las opciones de la variante |
| `InventoryQuantities` | Se establece en crear, **se pone a null en actualizar** (el stock se gestiona aparte) |

---

## Transformer 2 — Actualizar productos (`ProductsUpdateTransform`)

### Qué recibe

```csharp
[Input] Box<IProduct>  ProductosActualizarInput     // productos que han cambiado
[Input] Box<IVariant>  VariantesActualizarInput     // variantes que han cambiado
[Input] Box<IProduct>  RebuildProductOptionsInput   // productos cuyas opciones cambiaron
[Input] Box<string>    ProductosArchivarInput        // OriginIds de productos a archivar
```

### Lógica de actualización de variantes con imágenes

En la actualización, antes de mapear cada variante, el transformer resuelve las imágenes asignadas a esa variante:

```csharp
// Para cada variante a actualizar:
var variantImagesShopifyIds = variant.Images
    .Union(variant.GetParentImages())          // imágenes propias + del producto padre
    .Select(x => mediasOriginIdsToShopifyIds.TryGetValue(x.ToString(), out var value) ? value : null)
    .Where(x => !string.IsNullOrWhiteSpace(x))
    .Distinct()
    .Select(x => x!)
    .ToList();
```

Esto produce la lista de IDs de medias de Shopify que se usará para rellenar el metafield `galeria_imagenes` de la variante. Si la media no existe aún en Shopify (por ejemplo, es nueva), se omite de la lista.

### Lógica de archivado

El archivado es un caso especial dentro de este transformer. Al archivar:

1. Se consulta Shopify para saber si el producto ya está archivado (para evitar operaciones redundantes).
2. Si no está archivado, se genera un `ProductUpdateInput` con:
   - `Status = ARCHIVED`
   - `Handle` modificado: `"{handle-actual}-{fecha}-{número aleatorio}"` (para liberar el slug URL y evitar conflictos).

### Lógica de reconstrucción de opciones (RebuildProductOptions)

Cuando las opciones de un producto cambian (ej: antes tenía "Color+Talla" y ahora solo tiene "Color"), Shopify no permite actualizar las opciones directamente. Hay que usar la operación de reconstrucción que borra y vuelve a crear las opciones junto con todas las variantes.

Este transformer genera el input completo para esa operación: el ID de Shopify del producto y todas sus variantes con sus nuevas opciones.

---

## Transformer 3 — Borrar productos y variantes (`ProductsDeleteTransform`)

### Qué recibe

```csharp
[Input] Box<string>  ProductosEliminarInput   // OriginIds de productos
[Input] Box<string>  VariantesEliminarInput   // OriginIds de variantes
```

### Qué hace internamente

No usa AutoMapper. Solo resuelve IDs:

```
OriginId de producto  →  transactionsService.Products.FindShopifyIds(...)  →  DestinoId
OriginId de variante  →  transactionsService.Products.Variants.FindShopifyIds(...)  →  DestinoId

Para cada variante:
  DestinoId de variante  →  transactionsService.Products.Variants.FindProductsDestinationIdFromDestinationsIds(...)
                         →  DestinoId del producto padre
```

El resultado se organiza como un diccionario `{shopifyProductId → [shopifyVariantId1, shopifyVariantId2]}` porque la API de Shopify agrupa las eliminaciones de variantes por producto.

---

## Transformer 4 — Stock (`StockTransform`)

### La resolución EAN → DestinoId

Esta es la parte más interesante del transformer. El ERP devuelve stock por EAN, pero Shopify trabaja con `InventoryItemId`. El transformer construye un diccionario de traducción consultando la BD:

```csharp
var products = await transcationsService.Products.Get();
var helperDict = products
    .SelectMany(p => p.Variants.Select(v => new
    {
        VariantSku = v.Referencia,    // ← el EAN se guarda en el campo Referencia de la BD
        VariantShopifyId = v.DestinoId,
        ProductShopifyId = p.DestinoId
    }))
    .Where(x => !string.IsNullOrWhiteSpace(x.VariantSku))
    .GroupBy(x => x.VariantSku!)
    .ToDictionary(x => x.Key, x => x.ToList());
```

Hay un detalle importante: el mismo EAN puede corresponderse con más de una variante (si el mismo artículo físico tiene varias referencias en el catálogo). Por eso el diccionario agrupa por EAN (`GroupBy`), y para cada EAN en el stock del ERP, el transformer actualiza **todas las variantes** que tengan ese EAN.

### La lógica de variantes sin stock

Si una variante existe en la BD pero no aparece en la lista de stock del ERP, el transformer la establece a **0 unidades**:

```csharp
var inputSkus = _input.Select(y => y.Ean).ToHashSet();
var variantsWithMissingStock = helperDict
    .Where(x => !inputSkus.Contains(x.Key))   // variantes en BD pero no en el stock recibido
    .SelectMany(x => x.Value)
    .ToList();
foreach (var variant in variantsWithMissingStock)
{
    AddStockUpdate(variant.ProductShopifyId, variant.VariantShopifyId, 0);
}
```

Esto lo hace con un warning en los logs. La lógica es: si el ERP no informa de stock para un artículo que teóricamente existe, asumimos que está a 0 (mejor quedarse sin stock que tener stock incorrecto).

### Qué produce

```csharp
SyncStockInput
{
    Variants = Dictionary<string shopifyProductId, VariantStockUpdate[]>
}

VariantStockUpdate
{
    IdShopifyVariant = "gid://shopify/ProductVariant/..."
    LocationId       = "gid://shopify/Location/..."     // del appsettings.json
    Stock            = 42
}
```

---

## Transformer 5 — Imágenes (`ImagesTransform`)

### Las cinco operaciones de imagen

Este transformer es el más complejo en cuanto a superficie de entrada. Recibe cinco listas independientes porque las operaciones de imagen en Shopify son muy distintas entre sí:

```csharp
[Input] Box<IProductImage>                              ProductsImagesCreate   // imágenes nuevas
[Input] Box<IProductImage>                              ProductsImagesUpdate   // imágenes que cambiaron de URL
[Input] Box<string>                                     ProductsImagesDelete   // IDs de imágenes a borrar
[Input] Box<(ProductOriginId, VariantOriginId, ImageOriginId)> AppendMedias   // asociar imagen a variante
[Input] Box<(ProductOriginId, VariantOriginId, ImageOriginId)> DetachMedias   // desasociar imagen de variante
```

### Resolución de IDs por operación

Cada operación requiere resolver IDs distintos:

| Operación | IDs que necesita resolver |
|---|---|
| Crear | `ProductOriginId → ProductShopifyId` (para saber en qué producto crear la imagen) |
| Actualizar | `ImageOriginId → MediaShopifyId` (para saber qué media de Shopify actualizar) |
| Borrar | Recibe directamente los DestinoIds — no hay que resolver nada |
| Asociar | `ProductOriginId → ProductShopifyId` + `VariantOriginId → VariantShopifyId` |
| Desasociar | `ProductOriginId → ProductShopifyId` + `VariantOriginId → VariantShopifyId` + `ImageOriginId → MediaShopifyId` |

### Lógica de creación

```csharp
var create = _productsImagesCreate
    .GroupBy(x => x.ProductOriginId)
    .ToDictionary(
        x => productsOriginIdToShopifyId[x.Key]!,      // clave: ShopifyId del producto
        x => x.Select((productImage, i) => new OriginInput<IProductMedia>
        {
            OriginId = productImage.ImageOriginId,     // URL = identificador de la imagen
            Input = new ProductMediaUrl
            {
                Url      = productImage.ImageOriginId,
                MediaContentType = MediaContentType.IMAGE,
                Position = (uint)i
            }
        }).ToList());
```

Las imágenes se crean como `ProductMediaUrl`, indicando la URL de origen y el tipo de contenido. La `Position` se asigna según el orden dentro del grupo de imágenes de ese producto.

### Lógica de asociar y desasociar (`AppendMedias` / `DetachMedias`)

Las operaciones de asociar y desasociar vinculan o desvinculan una imagen de las variantes específicas que la muestran. En Shopify B2B esto es importante: cada variante puede tener su propia galería de imágenes.

Para la desasociación, además del ID del producto y de la variante, hay que saber el ID de la media en Shopify (porque se desasocia por ID, no por URL).

Si alguno de los IDs no puede resolverse (el producto, la variante o la media no existen en la BD), la operación se omite con un log de warning. Nunca se lanza excepción por esto.

### Qué produce

```csharp
ProductsMediasLoaderInput
{
    CreateMedias  = Dictionary<shopifyProductId, List<OriginInput<IProductMedia>>>
    UpdateMedias  = List<IProductMedia>                       // lista plana, con Id ya resuelto
    Delete        = string[]                                   // DestinoIds de medias a borrar
    AppendFiles   = null                                       // no se usa (para subir ficheros)
    AppendMedias  = Dictionary<shopifyProductId, List<(variantId, mediaId)>>
    DetachMedias  = Dictionary<shopifyProductId, List<(variantId, mediaId)>>
    PublishProductsWithMedias = true
}
```

---

## Transformer 6 — Clientes B2B (`CustomerTransform`)

### El perfil `CustomersMappingProfile`

Define cuatro mapeos:

#### `ClientResponseModel → CompanyInput`

| Campo Shopify | Valor |
|---|---|
| `ExternalId` | `Company.CodCom` (el código de cliente del ERP) |
| `Name` | `Company.Name` (razón social) |

Luego, fuera del mapper, se añaden metafields:

```csharp
// Añadir metafield zona_fiscal
metafields.Add(new MetafieldInput
{
    Namespace = "upng",
    Key = "zona_fiscal",
    Value = company.GetFiscalZone()  // = ZonaFiscal.zonaFiscal
});
```

#### `LocationResponseModel → CompanyLocationInput`

| Campo Shopify | Valor |
|---|---|
| `ExternalId` | `ILocation.OriginId` = `"{CodCom}#{Codadr}"` |
| `Name` | `Contact` (nombre del contacto de esa dirección) |
| `TaxRegistrationId` | `Crn` (número de IVA copiado del cliente padre) |
| `ShippingAddress` | `BuildAddress(location)` |
| `BillingAddress` | `BuildAddress(location)` (misma dirección para envío y facturación) |

#### `LocationResponseModel → CompanyLocationUpdateInput`

Para actualización, añade campos adicionales:

| Campo | Valor |
|---|---|
| `Phone` | Teléfono de la localización (null si vacío) |
| `BuyerExperienceConfiguration.EditableShippingAddress` | `true` (los clientes B2B pueden editar su dirección de envío) |

#### `LocationResponseModel → CompanyContactInput`

| Campo Shopify | Valor |
|---|---|
| `Email` | `Email` del location (este es el identificador único del contacto) |
| `Phone` | Teléfono (null si vacío) |

### `BuildAddress` — la conversión de dirección

La conversión de dirección es más compleja que un simple mapeo porque Shopify requiere códigos ISO estrictos, y el ERP puede enviar valores en formatos distintos.

```csharp
public static CompanyAddressInput BuildAddress(ILogger logger, LocationResponseModel location)
{
    // 1. Parsear el código de país a CountryCode enum de Shopify
    //    Si el ERP manda "ES", Shopify acepta CountryCode.ES
    //    Si falla el parseo, se loguea error y se pone null
    CountryCode? countryCode = Enum.TryParse<CountryCode>(location.Country, out var value) 
        ? value : null;

    // 2. Resolver el código de provincia mediante tabla de traducción
    //    ZoneCodes.TryGetZoneCode("ES", "MAD") → "ES-MD" (formato ISO 3166-2)
    string? zoneCode = ZoneCodes.TryGetZoneCode(countryCode.ToString(), location.ZoneCode);

    return new CompanyAddressInput
    {
        Address1  = location.Address1,
        Address2  = location.Address2,
        City      = location.City,
        Zip       = location.Zip,
        Recipient = location.Contact,       // nombre del destinatario
        Phone     = location.Phone,
        ZoneCode  = zoneCode,              // código de provincia en formato ISO
        CountryCode = countryCode          // código de país en formato ISO
    };
}
```

El `ZoneCodes.TryGetZoneCode` es una utilidad que traduce los códigos de provincia del ERP (formato interno de Sage X3) al formato ISO 3166-2 que requiere Shopify. Si no encuentra la traducción, se loguea un error y la dirección se crea sin código de provincia.

### Las tarifas de precios por defecto

En la creación de nuevas sucursales (locations), el transformer añade automáticamente la tarifa de precios por defecto configurada en `appsettings.json`:

```csharp
// Para cada location nueva:
location.DefaultPriceListId = config["ShopifyCredentials:DefaultPriceListId"];
```

### El `external_id` del contacto

Cuando se crea o actualiza un contacto (CompanyContact), el transformer añade un metafield `external_id` que almacena el email del contacto. Esto permite al workflow de pedidos encontrar el contacto correcto cuando llega un nuevo pedido.

```csharp
contactInput.Metafields.Add(new MetafieldInput
{
    Namespace = "upng",
    Key = "external_id",
    Value = customer.OriginId  // = email del contacto
});
```

---

## Transformer 7 — Pedidos (`OrdersMappingProfile`)

### El mapeo `Order → OrderHeaderModel`

| Campo del ERP | Lógica de mapeo |
|---|---|
| `Id` | `order.Name` → ej: `"#SS4185"` — el número de pedido legible de Shopify se convierte en el ID del documento en el ERP |
| `ShopifyId` | `order.Id` → el ID de GraphQL completo |
| `CreatedAt` | `order.CreatedAt` formateado como `"yyyy-MM-ddTHH:mm:ssK"` |
| `EjercicioDocumento` | Año de `CreatedAt` como entero → ej: `2026` |
| `CustomerId` | Se establece antes del mapeo: `company.ExternalId` = `CodCom` del cliente en el ERP |
| `ShippingAddressId` | `location.ExternalId` con la parte antes del `#` eliminada: `"C0001#DIR01"` → `"DIR01"` |
| `PaymentTerms` | `order.PaymentGatewayNames` unidos con coma |
| `ShippingLineCode` | Código de la primera línea de envío |
| `ShippingLinePrice` | Precio de envío sin IVA (coste de entrega) |
| `SubtotalPrice` | `SubtotalPriceSet.ShopMoney.Amount` |
| `TaxLine` | `TotalTaxSet.ShopMoney.Amount` (suma de todos los impuestos) |
| `TotalPrice` | `TotalPriceSet.ShopMoney.Amount` |
| `Note` | Notas del pedido en Shopify |
| `PoNumber` | Número de orden de compra del cliente |
| `ShippingAddress` | Solo se rellena si es dropshipping (ver más abajo) |

### La lógica de descuentos (header)

Los descuentos se calculan en `SetHeaderDiscountFields`:

```
TotalDiscount     = suma de descuentos de importe fijo (DiscountApplicationAllocationMethod.ACROSS + valor fijo)
TotalDiscountPrcnt = suma de descuentos de porcentaje (DiscountApplicationAllocationMethod.ACROSS + PricingPercentageValue)
```

Si no hay descuentos de porcentaje, `TotalDiscountPrcnt = null`. Si no hay descuentos de importe fijo, `TotalDiscount = 0`.

### El mapeo `LineItem → OrderLineModel`

| Campo del ERP | Lógica de mapeo |
|---|---|
| `ProductId` | `lineItem.Sku` → el SKU de la variante se convierte en la referencia del artículo en el ERP |
| `Title` | `lineItem.Name` |
| `Quantity` | `lineItem.Quantity` |
| `Price` | Precio unitario sin descuento (`GetLineItemPrice`) |
| `TotalPrice` | `DiscountedTotalSet.ShopMoney.Amount` (total de línea ya con descuentos) |
| `TotalDiscount` | Descuento de importe fijo de esa línea |
| `TotalDiscountPrcnt` | Descuento de porcentaje de esa línea (null si no hay) |

### La detección de dropshipping

Antes del mapeo se ejecuta `IsDropshipping(order)`:

```csharp
private static bool IsDropshipping(Order order)
{
    var orderAddress = order.ShippingAddress;            // dirección de envío del pedido
    var locationAddress = purchasingCompany?.Location?.ShippingAddress;  // dirección registrada de la sucursal

    // Si las dos direcciones son iguales → no es dropshipping → ShippingAddress = null en el ERP
    // Si son distintas → es dropshipping → se incluye la dirección del pedido para que el ERP la gestione
    return !Same(orderAddress.Address1, locationAddress.Address1)
        || !Same(orderAddress.Zip, locationAddress.Zip)
        || !Same(orderAddress.Province, locationAddress.Province)
        || !Same(orderAddress.Country, locationAddress.Country);
}
```

La comparación es insensible a mayúsculas y a espacios al inicio/final. Solo si la dirección de envío del pedido difiere de la registrada para la sucursal, se incluye `ShippingAddress` en el modelo del ERP. En caso contrario, el campo va a null (el ERP ya sabe la dirección de la sucursal).

---

## Transformer 8 — Tarifas de precio (`PriceListTransform`)

### El escenario de tarifas B2B

En Shopify B2B, una `PriceList` es un catálogo de precios específico que se asigna a una sucursal. Una sucursal puede tener una tarifa con precios específicos para cada variante, distintos del precio normal del catálogo.

El transformer gestiona tres tipos de cambios en una misma pasada:

#### Creación de tarifas (`_tarifasCrear`)

```
Para cada tarifa nueva:
  1. Añadir la tarifa al diccionario priceListsToCreate {OriginId → CurrencyCode}
  2. Para cada precio de la tarifa:
     · Resolver VariantOriginId → VariantShopifyId (BD de transacciones)
     · Generar PriceListPriceInput {VariantId, Price, CompareAtPrice}
```

#### Actualización de tarifas (`_tarifasEditar`)

Más complejo que la creación. Se divide en cuatro sub-operaciones:

1. **ExcludeProducts**: productos que estaban en la tarifa (según la BD) pero que ya no vienen del ERP → excluirlos de la tarifa en Shopify.
2. **SetProductVariantsFixedPrices**: establecer precios para variantes que llegan del ERP.
3. **ResetProductVariantsFixedPrices**: variantes que estaban con precio en la BD pero que ya no llegan del ERP → resetear su precio al predeterminado del catálogo.
4. Las reglas de cantidad (`QuantityRules`, `QuantityPriceBreaks`) están preparadas pero comentadas.

#### Eliminación de tarifas (`_tarifasEliminar`)

Solo pasa los `DestinoId` directamente al output, sin resolución de IDs adicional.

---

## Transformer 9 — Traducciones (`TranslationsTransform`)

### Los dos tipos de contenido que transforma

El transformer maneja dos pipelines independientes:

#### Traducciones de productos (`ITranslatableProduct`)

Para cada producto con contenido traducible, llama a `product.GetTranslations()` que devuelve un diccionario `{idioma → ProductTranslateModel}`. Luego resuelve el `OriginId` al `ShopifyId` del producto y construye el output.

#### Traducciones de metafields (`ITranslatable`)

Para el resto de entidades (variantes, companies, locations, contacts), llama a `item.GetTranslatableMetafields()` que devuelve `{locale → List<MetafieldInput>}`.

Cada tipo de entidad requiere una consulta diferente a la BD:

| Tipo | Método de la BD |
|---|---|
| `TranslationType.Product` | `transactionsService.Products.FindShopifyIds(...)` |
| `TranslationType.Variant` | `transactionsService.Products.Variants.FindShopifyIds(...)` |
| `TranslationType.Location` | `transactionsService.Companies.Locations.FindShopifyIds(...)` |
| `TranslationType.Company` | `transactionsService.Companies.FindShopifyIds(...)` |
| `TranslationType.Customer` | `transactionsService.Companies.Customers.FindShopifyIds(...)` |

### Qué produce

```csharp
TranslationsInput
{
    ProductsToTranslate     = Dictionary<shopifyProductId, Dictionary<locale, ProductTranslateModel>>
    MetafieldsToTranslate   = Dictionary<shopifyEntityId, Dictionary<locale, List<MetafieldInput>>>
}
```

---

## Resumen de la capa de transformación

```
Origen (modelos internos)            Transformer                    Destino (inputs de Shopify)
───────────────────────────────────  ─────────────────────────────  ──────────────────────────────────
Product + Variant (del PIM)     →    ProductsCreateTransform    →   ProductCreateInput
                                                                      + ProductVariantsBulkInput
                                                                      + 25+ metafields de producto
                                                                      + 20+ metafields de variante

Product + Variant (del PIM)     →    ProductsUpdateTransform    →   ProductUpdateInput
                                                                      + ProductVariantsBulkInput (con galería)
                                                                      + archive (ARCHIVED + nuevo handle)
                                                                      + rebuild options

OriginIds                       →    ProductsDeleteTransform    →   DestinoIds agrupados por producto

Stock {ean, qty}                →    StockTransform             →   SyncStockInput {variantId, qty, locationId}

IProductImage × 5 operaciones   →    ImagesTransform            →   ProductsMediasLoaderInput

ClientResponseModel/Location    →    CustomerTransform          →   CompanyInput
                                     + CustomersMappingProfile      + CompanyLocationInput
                                                                      + CompanyContactInput
                                                                      + metafields (zona_fiscal, external_id)

Order de Shopify                →    OrderTransform             →   OrderModel
                                     + OrdersMappingProfile         + OrderHeaderModel (formato ERP)
                                                                      + OrderLineModel × n líneas
                                                                      + detección dropshipping

IPriceList                      →    PriceListTransform         →   PriceListsB2BLoaderInput
                                                                      (precios, exclusiones, resets)

ITranslatable                   →    TranslationsTransform      →   TranslationsInput
                                                                      (traducciones por idioma)
```
