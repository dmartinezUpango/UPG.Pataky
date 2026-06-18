# 06 — Los modelos de datos

Este documento describe en detalle todos los modelos de datos del sistema: las interfaces que definen los contratos, los modelos del origen (ERP y PIM), los modelos intermedios que circulan entre capas, los modelos de salida al ERP y las entidades que persisten en la base de datos de transacciones.

---

## Índice

1. [Interfaces del dominio](#1-interfaces-del-dominio)
2. [Modelos del origen: ERP (ClientResponseModel)](#2-modelos-del-origen-erp)
3. [Modelos del origen: PIM (SalonSpaceProduct → Product)](#3-modelos-del-origen-pim)
4. [Modelo de stock](#4-modelo-de-stock)
5. [Modelos de pedido (salida al ERP)](#5-modelos-de-pedido-salida-al-erp)
6. [Modelos intermedios (Box, OriginInput, IActivityInput, ActivityResult)](#6-modelos-intermedios)
7. [Modelos de input de los loaders](#7-modelos-de-input-de-los-loaders)
8. [Entidades de la base de datos de transacciones](#8-entidades-de-la-base-de-datos-de-transacciones)

---

## 1. Interfaces del dominio

Las interfaces están en el proyecto `UPG.Pataky.Shared`, en la carpeta `Shared/Interfaces/`. Son contratos abstractos que describen qué puede hacer cada entidad del dominio, sin atarse a ninguna implementación concreta. El extractor de Provalliance devuelve `ClientResponseModel`, que implementa `ICompany`. El extractor de SalesLayer construye objetos `Product` que implementan `IProduct`. Las diferencias de implementación quedan ocultas detrás de la interfaz.

---

### `IStatus`

La interfaz base de la que heredan casi todas las interfaces de entidades. Define el estado de vida de una entidad.

```csharp
public interface IStatus
{
    EntityStatus Status { get; }
}

public enum EntityStatus
{
    Active = 0,
    Inactive = 1,
    Deleted = 2
}
```

- **`Active`**: la entidad existe y debe estar visible/activa en el destino.
- **`Inactive`**: la entidad existe pero está en borrador (en Shopify: `DRAFT`).
- **`Deleted`**: la entidad ya no existe en el origen y debe borrarse o archivarse en el destino.

El `Status` de un producto se **agrega** desde el estado de sus variantes (si todas están borradas, el producto está borrado; si alguna está activa, el producto está activo).

---

### `IProduct` e `ITranslatableProduct`

```csharp
public interface IProduct : IStatus
{
    string OriginId { get; }
    ICollection<IVariant> GetVariants();
    IDictionary<string, ICollection<string>> GetSortedOptions();
}

public interface ITranslatableProduct : IProduct
{
    IDictionary<string, ProductTranslateModel> GetTranslations();
}
```

- **`OriginId`**: identificador del producto en el sistema origen. En SalesLayer es el `codigo_agrupacion` (SKU del grupo de variantes).
- **`GetVariants()`**: devuelve todas las variantes del producto.
- **`GetSortedOptions()`**: devuelve un diccionario con cada opción del producto (ej. "Talla") y todos sus valores ordenados (ej. ["XS","S","M","L","XL"]). Es lo que Shopify necesita para definir las opciones del producto.
- **`ITranslatableProduct`**: extensión para productos con soporte multilingüe, añade `GetTranslations()` que devuelve las traducciones indexadas por idioma.

---

### `IVariant` e `IVariantStock`

```csharp
public interface IVariant : IStatus
{
    string ProductOriginId { get; init; }
    string OriginId { get; }
    IDictionary<string, string> GetSelectedOptions();
}

public interface IVariantStock
{
    string VariantOriginId { get; init; }
    int GetStock();
}
```

- **`OriginId`**: identificador único de la variante en el origen. En la implementación `Variant` del PIM es `"{parent.OriginId}#{OriginObject.Id}"`, combinando el SKU del grupo con el ID interno de SalesLayer.
- **`ProductOriginId`**: referencia al producto padre.
- **`GetSelectedOptions()`**: devuelve el valor concreto que esta variante tiene para cada opción (ej. `{"Talla": "M", "Color": "Negro"}`). Esta información viene del campo `agrupacion` del PIM.
- **`IVariantStock`**: interfaz separada para el modelo de inventario. `VariantOriginId` identifica la variante y `GetStock()` devuelve su cantidad.

---

### `ICompany`, `ILocation` e `ICustomer`

Estas tres interfaces modelan la jerarquía B2B de Shopify: **Company → Location → Customer**.

```csharp
public interface ICompany : IStatus
{
    string OriginId { get; }
    ICollection<ICustomer> GetCustomers();
    ICustomer? GetMainContact();
    ICollection<ILocation> GetLocations();
    IDictionary<string, ICollection<string>> GetPriceListsIds();
    string GetFiscalZone();
}

public interface ILocation : IStatus
{
    string OriginId { get; }
    ICollection<ICustomer> GetCustomers();
    ICollection<string> GetPriceListsIds();
}

public interface ICustomer
{
    string OriginId { get; }
    string GetRoleOriginId(ILocation location)
        => $"{location.OriginId}-{OriginId}";  // implementación por defecto
}
```

**Relaciones entre interfaces:**
- Una `ICompany` tiene muchas `ILocation` y muchos `ICustomer`.
- Cada `ILocation` tiene sus propios `ICustomer`.
- Un `ICustomer` no implementa `IStatus` porque no tiene estado propio — su estado está implícito en el de su `ILocation`.
- `GetRoleOriginId()` tiene una implementación por defecto en la interfaz misma. El `OriginId` de un rol (asignación de un contacto a una location) es siempre `"{locationOriginId}-{customerOriginId}"`.
- `GetFiscalZone()` devuelve la zona fiscal del cliente, que en el ERP es el campo `VACBPR` (valores: `EXE`, `es_re:REQ`, `es`, y otros). Se usa para el metafield `upng.zona_fiscal` de la Company en Shopify.
- `GetPriceListsIds()` en `ICompany` devuelve un diccionario `locationOriginId → [priceListOriginId, ...]`, y en `ILocation` devuelve solo los IDs de las tarifas de esa sucursal. En la implementación actual del ERP siempre devuelve vacío (las tarifas se gestionan por otro workflow).

---

### `IPriceList` e `IVariantPrice`

```csharp
public interface IPriceList
{
    string OriginId { get; }
    CurrencyCode CurrencyCode { get; }
    ICollection<IVariantPrice> GetPrices();
    ICollection<string> GetIncludedVariants();
    ICollection<string> GetExcludedProducts();
}

public interface IVariantPrice
{
    string ProductOriginId { get; init; }
    string VariantOriginId { get; }
    decimal GetPrice();
    decimal GetPriceIncrement();
}
```

- **`OriginId`**: el código de la tarifa en el ERP.
- **`CurrencyCode`**: enumerado de Shopify con el código ISO de la divisa (EUR, USD...).
- **`GetPrices()`**: la lista de precios por variante incluidos en esta tarifa.
- **`GetIncludedVariants()`**: OriginIds de variantes con precio explícito (las que sí están en la tarifa).
- **`GetExcludedProducts()`**: OriginIds de productos excluidos de la tarifa (no aparecerán para los clientes asignados a ella).
- **`GetPriceIncrement()`**: precio de comparación (precio tachado). Si es mayor que `GetPrice()`, en Shopify aparece como precio original tachado.

---

### `IProductImage`

```csharp
public interface IProductImage
{
    string ImageOriginId { get; init; }
    string ProductOriginId { get; init; }
    List<string>? ProductVariantsOriginId { get; }
}
```

- **`ImageOriginId`**: la URL de la imagen en SalesLayer (actúa como identificador único de la imagen).
- **`ProductOriginId`**: a qué producto pertenece la imagen.
- **`ProductVariantsOriginId`**: lista de OriginIds de variantes que tienen asignada esta imagen. Puede ser null o vacía si la imagen es del producto padre (imagen compartida por todas las variantes).

---

### `ITranslatable`

```csharp
public interface ITranslatable
{
    string OriginId { get; init; }
    TranslationType TranslationType { get; init; }
    IDictionary<string, ICollection<MetafieldInput>> GetTranslatableMetafields();
}

public enum TranslationType
{
    Company, Location, Product, Variant, Customer
}
```

- Utilizada por `TranslationsTransform` para convertir entidades con contenido multilingüe en traducciones de Shopify.
- `GetTranslatableMetafields()` devuelve un diccionario `idioma → [MetafieldInput]` con los metafields a traducir.

---

### `IOrder<TCabecera, TLineaPedido>`

```csharp
public interface IOrder<TCabecera, TLineaPedido>
{
    string OriginId { get; }
    Order ShopifyOrder { get; }
    TCabecera Header { get; init; }
    ICollection<TLineaPedido> Lines { get; init; }
}

public interface IOrderStatus
{
    string OriginId { get; }
    ElsaShared.Data.Shopify.EnumOrderState Status { get; }
}
```

- Es una interfaz genérica para no acoplar la capa de integración al formato concreto del ERP.
- `OriginId` = el nombre del pedido en Shopify (ej: `#SS4185`).
- `ShopifyOrder` = el objeto Shopify original (por si el loader necesita algo no mapeado).
- `IOrderStatus` modela los estados de un pedido: `CREADO`, `PAGADO`, `ENVIADO_PARCIAL`, `ENVIADO`, `CANCELADO`, `ENTREGADO`.

---

### `IActivityInput`

```csharp
public interface IActivityInput
{
    bool RunActivity { get; }
    void CheckAndThrowExceptions();
}
```

Todos los modelos de input de los loaders implementan esta interfaz. Es el mecanismo que permite a `BaseActivity<T>` saltarse su ejecución de forma limpia:

- **`RunActivity`**: si es `false`, la actividad no hace nada y termina inmediatamente. Evita llamadas a Shopify innecesarias cuando no hay datos que procesar.
- **`CheckAndThrowExceptions()`**: se llama antes de ejecutar la actividad para validar que el input es coherente. Si detecta un problema lanza una excepción.

---

## 2. Modelos del origen: ERP

Los modelos del ERP viven en `Extractors/Models/` y representan la respuesta de la API de Provalliance (Sage X3) tal como viene del middleware REST.

---

### `ClientResponseModel`

Es el objeto raíz de un cliente. Implementa `ICompany`. La API del ERP devuelve un array de estos objetos paginado.

```
ClientResponseModel
├── Company (BPC0_1) → CompanyResponseModel
│   ├── CodCom (BPCNUM) → "C0001"              ← OriginId de la empresa
│   ├── Name (BPCNAM)   → "Peluquería García"
│   └── Zbpcshopify     → flag interno ERP
│
├── Bprc1 (BPRC_1) → datos fiscales y de pago
│   ├── Crn             → "B12345678"           ← NIF/CIF de la empresa
│   ├── Cur             → "EUR"
│   ├── Lan             → idioma
│   └── ...
│
├── ZonaFiscal (BPC3_2) → ZonaFiscal
│   └── zonaFiscal (VACBPR) → "EXE" | "es_re:REQ" | "es"
│
├── Bprc5 (BPRC_5) → datos EDI
│   └── Zediflg, Zediref
│
├── Locations (BPAC_1) → LocationResponseModel[]  ← las sucursales
├── Bpc26 (BPC2_6) → códigos de tarifa (TSCCOD[])
├── Bpc31 (BPC3_1) → facturación y riesgo
├── Bpc33 (BPC3_3) → condiciones de pago (PTE)
├── Bpc41 (BPC4_1) → array de traducciones del nombre
└── Adxtec          → metadatos de auditoría (WW_MODSTAMP, WW_MODUSER)
```

**Métodos implementados:**
- `OriginId` → `Company.CodCom` (el código de empresa del ERP)
- `GetCustomers()` → `new List<ICustomer>(Locations)` — cada sucursal es también un cliente
- `GetLocations()` → `new List<ILocation>(Locations)` — las mismas locations
- `GetMainContact()` → `Locations.First()` — la primera sucursal como contacto principal
- `GetFiscalZone()` → `ZonaFiscal.zonaFiscal` — la zona fiscal para el metafield de Shopify
- `GetPriceListsIds()` → devuelve diccionario vacío (las tarifas no se gestionan desde aquí)

> **Nota**: `ClientResponseModelContainer` es el wrapper de paginación: contiene `List<ClientResponseModel> ClientsList` y `string NextPageLink` para seguir con la página siguiente.

---

### `LocationResponseModel`

Es la entidad más interesante del sistema por su **doble rol**: implementa tanto `ILocation` como `ICustomer` al mismo tiempo. En la jerarquía B2B de Shopify, una sucursal del ERP se convierte en dos entidades diferentes:

- Como **`ILocation`** → se convierte en una `CompanyLocation` de Shopify (la dirección física).
- Como **`ICustomer`** → se convierte en un `Customer` de Shopify (la persona que puede hacer login).

Esta ambigüedad se resuelve con implementaciones de interfaz explícitas:

```csharp
string ILocation.OriginId => LocationOriginId;  // "C0001#DIR01"
string ICustomer.OriginId => Email;             // "garcia@peluqueria.es"
```

**Todos los campos del ERP:**

| Campo C# | Campo ERP (JSON) | Descripción |
|---|---|---|
| `Codadr` | `CODADR` | Código de dirección en el ERP |
| `Contact` | `BPADES` | Nombre del contacto / denominación de la sucursal |
| `Country` | `BPACRY` | Código de país ISO de 2 letras (ej: "ES", "FR") |
| `Crynam` | `CRYNAM` | Nombre del país en texto |
| `Address1` | `ADDLIG1` | Primera línea de dirección |
| `Address2` | `ADDLIG2` | Segunda línea de dirección |
| `Addlig3` | `ADDLIG3` | Tercera línea de dirección (no usada) |
| `Zip` | `POSCOD` | Código postal |
| `City` | `CTY` | Ciudad |
| `ZoneCode` | `SAT` | Código de provincia en formato ERP (ej: "AN", "CA") |
| `Phone` | `TEL1` | Teléfono principal |
| `Tel2-5` | `TEL2-5` | Teléfonos adicionales (no usados) |
| `Email` | `WEB1` | Email — siempre se normaliza: `.Trim().ToLowerInvariant()` |
| `Web2-5` | `WEB2-5` | Webs adicionales (no usadas) |
| `Fcyweb` | `FCYWEB` | Fecha web |
| `Extnum` | `EXTNUM` | Número externo |
| `Flmod` | `FLMOD` | Flag modificación |
| `Adrval` | `ADRVAL` | Validación de dirección |

**Campos especiales:**
- `Crn`: el NIF/CIF. Está marcado con `[JsonIgnore]` — **no viene en el JSON de la location**, sino que el extractor lo copia manualmente desde el `Bprc1.Crn` del `ClientResponseModel` padre. Esto es porque en el ERP el NIF pertenece a la empresa, no a cada sucursal.
- `LocationOriginId`: también se asigna manualmente (no viene del JSON). El extractor lo construye como `"{CodCom}#{Codadr}"` (ej: `"C0001#DIR01"`).
- `Status`: siempre devuelve `EntityStatus.Active` — las locations no tienen estado propio en el ERP.

**Métodos implementados:**
- `GetCustomers()` → `new List<ICustomer>() { this }` — cada location es también su propio cliente.
- `GetPriceListsIds()` → lista vacía.

---

### `CompanyResponseModel`

Submodelo anidado dentro de `ClientResponseModel`. Contiene los datos básicos de la empresa:

```csharp
public class CompanyResponseModel
{
    public string Bcgcod { get; set; }      // código de grupo
    public string CodCom { get; set; }      // BPCNUM → el ID de empresa
    public string Name { get; set; }        // BPCNAM → nombre
    public string Zbpcshopify { get; set; } // flag interno ERP
}
```

---

### `ZonaFiscal`

```csharp
public class ZonaFiscal
{
    public string zonaFiscal { get; set; }  // VACBPR → "EXE" | "es_re:REQ" | "es"
    public string Vatexn { get; set; }       // número de excepción IVA
}
```

El valor de `zonaFiscal` determina el metafield `upng.zona_fiscal` de la Company en Shopify:
- `"EXE"` → cliente exento de IVA
- `"es_re:REQ"` → cliente en recargo de equivalencia
- `"es"` (u otro valor) → cliente con IVA normal

---

## 3. Modelos del origen: PIM

El PIM (SalesLayer) devuelve los datos de producto en dos capas:

1. **`SalonSpaceProduct`** → el objeto crudo tal como viene del JSON del PIM. Tiene todos los campos (más de 100).
2. **`Product`** + **`Variant`** → los objetos del dominio que el sistema construye a partir de los datos del PIM. Implementan las interfaces `IProduct` e `IVariant`.

---

### `SalonSpaceProduct` — el objeto crudo del PIM

Es una clase masiva con todos los campos que devuelve SalesLayer. Está decorada con `[JsonConverter(typeof(DynamicTranslatableConverter))]` porque algunos campos son traducibles (tipo `Translatable<string>`) y el convertidor decide en tiempo de deserialización si parsear un string o un objeto de traducciones.

**Campos del PIM agrupados por categoría:**

**Identificadores y estado:**

| Campo C# | JSON Key | Tipo | Descripción |
|---|---|---|---|
| `Id` | `ID` | string | ID interno de SalesLayer |
| `Sku` | `sku` | string | SKU del ERP (referencia de producto) |
| `Ean` | `ean` | string | EAN principal |
| `Ean1` | `ean_1` | string | EAN alternativo 1 |
| `Ean2` | `ean_2` | string | EAN alternativo 2 |
| `Ean3` | `ean_3` | string | EAN alternativo 3 |
| `CodigoAgrupacion` | `codigo_agrupacion` | string? | SKU del producto padre (solo en variantes de producto multi-variante) |
| `Agrupacion` | `agrupacion` | List\<string\> | Nombre de las dimensiones de variante (ej: `["Talla"]` o `["Talla+Color"]`) |
| `Estatus` | `estatus` | Estatus | `Visible`, `Borrador` o `Invisible` |
| `Obsoleto` | `obsoleto` | bool | Si está marcado como obsoleto (se ignora a efectos de sincronización) |
| `Status` | `STATUS` | string | Estado interno de SalesLayer |
| `IdCategories` | `ID_categories` | string | ID de la categoría en SalesLayer |
| `Categoria` | `categoria` | string | Nombre de la categoría |

**Contenido traducible:**

| Campo C# | JSON Key | Tipo | Descripción |
|---|---|---|---|
| `NombreProducto` | `nombre_producto` | Translatable\<string\> | Nombre de la variante |
| `ParentProductName` | `parent_product_name` | Translatable\<string\> | Nombre del producto agrupado |
| `ShortProductDescription` | `short_product_description` | Translatable\<string\> | Descripción corta |
| `LongProductDescription` | `long_product_description` | Translatable\<string\> | Descripción larga |
| `DescripcionProfesional` | `descripcion_profesional` | Translatable\<string\> | Descripción profesional |
| `HowToUse` | `how_to_use` | Translatable\<string\> | Modo de uso |
| `KeyFeatures` | `key_features` | Translatable\<string\> | Características clave |
| `Benefits` | `benefits` | Translatable\<string\> | Beneficios |
| `AdditionalBenefits` | `additional_benefits` | Translatable\<string\> | Beneficios adicionales |
| `Ingredients` | `ingredients` | Translatable\<string\> | Ingredientes |
| `WarrantiesAndCertifications` | `warranties_and_certifications` | Translatable\<string\> | Garantías y certificaciones |
| `HairType` | `hair_type` | Translatable\<string\> | Tipo de cabello |
| `Color` | `color` | Translatable\<string\> | Color |
| `MetaTitle` | `meta_title` | Translatable\<string\> | Metatítulo SEO de la variante |
| `MetaDescription` | `meta_description` | Translatable\<string\> | Metadescripción SEO de la variante |

**SEO y URLs:**

| Campo C# | JSON Key | Tipo | Descripción |
|---|---|---|---|
| `UrlSeo` | `url_seo` | string | Handle/URL de la variante para Shopify |
| `ParentUrlSeo` | `parent_url_seo` | string | Handle del producto agrupado |
| `ParentMetatitle` | `parent_metatitle` | string | Metatítulo SEO del producto agrupado |
| `ParentMetadescription` | `parent_metadescription` | string | Metadescripción del producto agrupado |

**Marca y categorización:**

| Campo C# | JSON Key | Tipo | Descripción |
|---|---|---|---|
| `Brand` | `brand` | List\<string\> | Marcas (puede ser lista) |
| `BrandFamily` | `brand_family` | string | Familia de marca |
| `BrandSubfamily` | `brand_subfamily` | string | Subfamilia de marca |
| `BrandLine` | `brand_line` | string | Línea de marca |
| `ShopifyLineaMarca` | `shopify_linea_marca` | string | Línea de marca para Shopify |
| `ShopifyCategory` | `shopify_category` | string | Categoría de Shopify |
| `ShopifySubcategory` | `shopify_subcategory` | string | Subcategoría de Shopify |
| `CategoryName` | `category_name` | string | Nombre categoría |

**Producto y variante:**

| Campo C# | JSON Key | Tipo | Descripción |
|---|---|---|---|
| `SkuType` | `sku_type` | string | `"material"` (físico) o `"digital"` |
| `NivelImpuesto` | `nivel_impuesto` | string | `NOR`, `RED` o `SRD` → determina IVA (21%, 10%, 4%) |
| `ContentValue` | `content_value` | string | Contenido (ej: "250") |
| `ContentType` | `content_type` | List\<string\> | Unidad de contenido (ej: ["ml"]) |
| `UnitsPerBox` | `units_per_box` | string | Unidades por caja |
| `Weight` | `weight` | string | Peso |
| `SalonSpaceSellingPrice` | `salon_space_selling_price` | string | PVP |
| `SalonSpaceSpecialSellingPrice` | `salon_space_special_selling_price` | string | Precio especial de venta |
| `ProfessionalUse` | `professional_use` | string | Uso profesional |
| `TargetGender` | `target_gender` | List\<string\> | Género objetivo |
| `HairNeed` | `hair_need` | List\<object\> | Necesidad capilar |
| `Etiqueta` | `etiqueta` | List\<string\> | Tags del producto |
| `PrvPacksSkus1` | `prv_packs_skus_1` | Dictionary\<string,string\> | Packs: clave = ID SalesLayer, valor = SKU ERP |
| `FichaTecnica` | `ficha_tecnica` | string | URL de la ficha técnica |
| `SafetyWarningContent` | `safety_warning_content` | string | Advertencias de seguridad |

**Imágenes:**

| Campo C# | JSON Key | Tipo | Descripción |
|---|---|---|---|
| `Imagenes` | `imagen_de_producto` | List\<SLUri\>? | Imágenes propias de esta variante |
| `ImagenesProductosAgrupados` | `imagen_productos_agrupados` | List\<SLUri\>? | Imágenes del producto padre (compartidas) |

**Filtros de categorización (40+ campos):** Los campos `tipo_*` y `funcion_*` corresponden a los metafields `custom.filtro_*` de Shopify. Hay filtros para: tintes, champús, acondicionadores, mascarillas, serum, styling (lacas, ceras, gominas, espumas), accesorios (planchas, secadores, cepillos, peines, rizadores, utensilios), cuidado del hombre (barbería, afeitado), belleza (cejas, pestañas, depilación, manicura, pedicura).

---

### `Product` — modelo de dominio del PIM

`Product` es la clase que el sistema construye a partir de un grupo de `SalonSpaceProduct` con el mismo `codigo_agrupacion`. Es la implementación de `IProduct`.

**Constructor:** `Product(string originId, ICollection<SalonSpaceProduct> originalVariants)`

Proceso de construcción:
1. Convierte cada `SalonSpaceProduct` en un `Variant`.
2. Si solo hay una variante → es el "main variant" y sus opciones se fijan a `{"Title": "Default Title"}`.
3. Si hay múltiples variantes → busca el "main variant" (el que tiene el `CodigoAgrupacion` igual al `originId`). Los nombres de las dimensiones de opción (ej: "Talla", "Color") se leen del campo `agrupacion` del main variant, separando por `+`. Para cada variante, resuelve el valor de cada dimensión accediendo al campo JSON con ese nombre normalizado (en minúsculas con guiones bajos).

**Estado del producto:** se agrega desde los estados de todas sus variantes:
- Si todas las variantes tienen el mismo estado → ese es el estado.
- Si hay mezcla y alguna es `Active` → el producto es `Active`.
- Si hay mezcla y alguna es `Inactive` → `Inactive`.
- Si hay mezcla y alguna es `Deleted` → `Deleted`.

**Métodos principales:**
- `GetVariants()` → todas las variantes como `IVariant`.
- `GetMainVariant()` → la variante que representa al producto como conjunto.
- `GetNumVariants()` → cuenta de variantes.
- `GetVariantsImages()` → imágenes de variantes agrupadas por URL. Si la misma URL aparece en varias variantes, se crea un único `ProductImage` con todas las `ProductVariantsOriginId`.
- `GetParentImages()` → imágenes del producto agrupado (`ImagenesProductosAgrupados` del main variant), sin asignación a variantes específicas.
- `GetSortedOptions()` → diccionario `opción → [valores en orden]`, donde el orden sigue el de las variantes.
- `GetTags()` → `HashSet<string>` de todos los tags de todas las variantes (campo `etiqueta`).
- `RemoveDuplicatedVariants()` → elimina variantes duplicadas por `OriginId`. Solo puede llamarse una vez (protección con flag).

---

### `Variant` — modelo de dominio de variante del PIM

```csharp
public class Variant(Product parent, SalonSpaceProduct originObject) : IVariant
{
    public SalonSpaceProduct OriginObject { get; }  // acceso al objeto crudo del PIM
    public EntityStatus Status => OriginObject.Estatus switch
    {
        Estatus.Visible   => EntityStatus.Active,
        Estatus.Borrador  => EntityStatus.Inactive,
        Estatus.Invisible => EntityStatus.Deleted,
    };
    public string ProductOriginId { get => parent.OriginId; }
    public string OriginId => $"{parent.OriginId}#{OriginObject.Id}";
    public IDictionary<string, string>? Options { get; set; }  // asignado por el Product padre
    public List<Uri> Images => OriginObject.Imagenes?.Select(x => x.Org).ToList() ?? [];
}
```

- El `OriginId` de una variante es siempre el SKU del grupo más el ID interno de SalesLayer: `"GHD001#12345"`.
- `Options` es nulo hasta que el constructor de `Product` lo asigna. Si se accede antes de que esté asignado, `GetSelectedOptions()` lanza `InvalidOperationException`.
- `GetParentImages()` delega en el producto padre para obtener las imágenes compartidas.
- La propiedad `OriginObject` expone el `SalonSpaceProduct` completo, permitiendo a los transformers acceder a cualquier campo del PIM directamente.

---

### `ProductImage`

```csharp
public class ProductImage : IProductImage
{
    public required string ImageOriginId { get; init; }    // URL de la imagen en SalesLayer
    public required string ProductOriginId { get; init; }  // SKU del producto
    public List<string>? ProductVariantsOriginId { get; init; }  // OriginIds de variantes
}
```

Hay dos orígenes de `ProductImage`:
- **Imágenes de variante** (`GetVariantsImages()`): si varias variantes tienen la misma URL, se agrupa en un solo `ProductImage` con todas las `ProductVariantsOriginId`.
- **Imágenes del producto padre** (`GetParentImages()`): imágenes compartidas por todas las variantes, `ProductVariantsOriginId` está vacío.

---

## 4. Modelo de stock

```csharp
public struct Stock
{
    public required string Ean { get; init; }
    public required string Warehouse { get; init; }
    public required int Quantity { get; init; }
}
```

Es la estructura más simple del sistema. Viene del ERP en formato JSON:

```json
{ "ean": "8432023456789", "warehouse": "ES001", "quantity": 42 }
```

- Es un `struct` (tipo por valor), no una clase, porque es un dato simple e inmutable.
- `Ean` es la clave que el transformer usa para resolver la variante en Shopify, consultando la BD de transacciones por el campo `Referencia`.
- `Warehouse` es el almacén del ERP. En el sistema actual solo se trabaja con un único almacén en Shopify.
- `Quantity` puede ser 0 (agotado) pero nunca negativo.

---

## 5. Modelos de pedido (salida al ERP)

Los modelos de pedido están en `Extractors/Models/Orders/Models/`. Son el resultado de transformar un pedido de Shopify al formato que espera el ERP (Provalliance).

---

### `OrderModel`

El objeto contenedor de todo el pedido transformado. Implementa `IOrder<OrderHeaderModel, OrderLineModel>`.

```csharp
public class OrderModel(Order order) : IOrder<OrderHeaderModel, OrderLineModel>
{
    public string OriginId => ShopifyOrder.Name;     // "#SS4185"
    public required Order ShopifyOrder { get; init; } // el Order de Shopify original
    public required OrderHeaderModel Header { get; init; }
    public required ICollection<OrderLineModel> Lines { get; init; }
}
```

- `OriginId` es el `Name` del pedido en Shopify (el número de pedido legible, ej: `#SS4185`).
- Lleva el `ShopifyOrder` original porque el loader puede necesitar acceder a campos de Shopify no mapeados en el Header.

---

### `OrderHeaderModel`

La cabecera del pedido en formato ERP. Todos los campos se serializan con `Newtonsoft.Json`.

| Campo C# | JSON Key | Tipo | Origen |
|---|---|---|---|
| `Id` | `id` | string | `order.Name` (ej: `#SS4185`) |
| `ShopifyId` | `shopifyId` | string | GID de Shopify del pedido |
| `CreatedAt` | `created_at` | string? | Fecha formateada: `"yyyy-MM-ddTHH:mm:ssK"` |
| `EjercicioDocumento` | `ejercicioDocumento` | int | Año del pedido (de `CreatedAt`) |
| `CustomerId` | `customerId` | string? | Fijado por el transformer, no por AutoMapper |
| `ShippingAddressId` | `shippingAddressId` | string? | ExternalId de la location en Shopify, con el prefijo hasta `#` eliminado: `"C0001#DIR01"` → `"DIR01"` |
| `PaymentTerms` | `paymenTerms` | string? | Métodos de pago del pedido unidos por `", "` |
| `ShippingLineCode` | `shippingLineCode` | string? | Código del primer servicio de envío |
| `ShippingLinePrice` | `shippingLinePrice` | decimal? | Coste de envío sin IVA |
| `SubtotalPrice` | `subtotalPrice` | decimal? | Subtotal (sin descuentos de cabecera, sin envío, sin IVA) |
| `TaxLine` | `taxLine` | decimal? | Total de IVA |
| `TotalPrice` | `totalPrice` | decimal? | Total final del pedido |
| `TotalDiscount` | `totalDiscount` | decimal? | Descuento fijo de cabecera (importe) |
| `TotalDiscountPrcnt` | `totalDiscountPrcnt` | decimal? | Descuento porcentual de cabecera (importe en €) |
| `Note` | `note` | string? | Nota del pedido |
| `PoNumber` | `poNumber` | string? | Número de pedido del cliente (purchase order) |
| `ShippingAddress` | `shipping_address` | OrderShippingAddressModel? | Solo presente si es dropshipping |
| `LineasDocumento` | `line_items` | ICollection\<OrderLineModel\>? | Las líneas del pedido |

> **Descuentos**: en Shopify un descuento puede ser de tipo `ACROSS` (se aplica a todo el pedido) o por línea. Los descuentos `ACROSS` van al header; los de línea van a cada `OrderLineModel`. Además, pueden ser de importe fijo o porcentaje. La separación se hace en `SetHeaderDiscountFields` y `SetLineDiscountFields`.

---

### `OrderLineModel`

Una línea del pedido en formato ERP.

| Campo C# | JSON Key | Tipo | Origen |
|---|---|---|---|
| `Price` | `price` | decimal | Precio unitario sin descuento |
| `Quantity` | `quantity` | int | Cantidad de unidades |
| `ProductId` | `productId` | string | **El SKU de Shopify** — que coincide con la referencia del ERP |
| `Title` | `title` | string | Nombre del producto en la línea (`LineItem.Name`) |
| `TotalDiscount` | `totalDiscount` | decimal | Descuento fijo de esta línea |
| `TotalDiscountPrcnt` | `totalDiscountPrcnt` | decimal? | Descuento porcentual de esta línea |
| `TotalPrice` | `totalPrice` | decimal | Total de la línea después de descuentos |

> **Importante**: `ProductId` lleva el SKU, no el GID de Shopify. En el ERP, el identificador de producto es el SKU/referencia. La configuración de Shopify obliga a que el SKU del `LineItem` sea la referencia del ERP para que este mapeo funcione.

---

### `OrderShippingAddressModel`

Solo se incluye en el `OrderHeaderModel` cuando el pedido es un **dropshipping** (la dirección de envío es diferente a la dirección registrada de la sucursal).

| Campo C# | JSON Key | Descripción |
|---|---|---|
| `FirstName` | `first_name` | Nombre del destinatario |
| `LastName` | `last_name` | Apellidos |
| `Address1` | `address1` | Primera línea de dirección |
| `Address2` | `address2` | Segunda línea |
| `City` | `city` | Ciudad |
| `Zip` | `zip` | Código postal |
| `Province` | `province` | Provincia en texto |
| `Country` | `country` | País en texto |
| `Phone` | `phone` | Teléfono |
| `CountryCode` | `country_code` | Código ISO del país |
| `ProvinceCode` | `province_code` | Código de la provincia |

La detección de dropshipping compara los campos `Address1`, `Zip`, `Province` y `Country` del pedido contra los de la `ShippingAddress` de la location del comprador en Shopify. Si cualquiera difiere (ignorando mayúsculas y espacios), es dropshipping.

---

## 6. Modelos intermedios

Estos modelos no representan datos del negocio sino infraestructura del sistema: resuelven problemas de serialización, transporte de metadatos y comunicación entre actividades.

---

### `Box<T>` y `Box<T, U>`

```csharp
public class Box<T>
{
    public ICollection<T> Property { get; set; } = null!;

    public static implicit operator Box<T>(List<T> property) => new(property);
    public static implicit operator Box<T>(T[] property) => new(property);
}

public class Box<T, U>
{
    public IDictionary<T, U> Property { get; set; } = null!;
}
```

**El problema que resuelve:** Elsa Workflows usa JSON para serializar/deserializar las variables del workflow (los datos que pasan entre actividades). Cuando el tipo es una interfaz genérica como `ICollection<IProduct>`, el serializador JSON no puede reconstruirla al deserializar porque no sabe qué clase concreta usar.

**La solución:** envolver la colección en una clase concreta con una propiedad de nombre fijo (`Property`). `Box<IProduct>` serializa como `{"Property": [...]}` — una estructura que el serializador puede manejar correctamente.

```csharp
// Sin Box → error en deserialización
WorkflowVariable<ICollection<IProduct>> productos;

// Con Box → funciona
WorkflowVariable<Box<IProduct>> productos;
```

Las conversiones implícitas permiten escribir directamente `Box<IProduct> box = myList;` sin necesidad de `new Box<IProduct>(myList)`.

`Box<T, U>` sirve para diccionarios: `Box<string, CompanyInput>` envuelve un `IDictionary<string, CompanyInput>`.

---

### `OriginInput<T>`

```csharp
public class OriginInput<T>
{
    public required string OriginId { get; set; }
    public string? Reference { get; set; }
    public required T Input { get; set; }
}
```

**El problema que resuelve:** cuando el Loader crea una entidad en Shopify, recibe de vuelta un `DestinoId` (el GID de Shopify). Para poder registrar ese nuevo par `OriginId → DestinoId` en la BD de transacciones, el loader necesita saber cuál era el `OriginId` original. Pero si solo recibe el input de la API de Shopify (ej: `ProductCreateInput`), esa información se ha perdido.

`OriginInput<T>` viaja junto con el input de Shopify y lleva consigo el `OriginId` del ERP/PIM.

```csharp
new OriginInput<ProductCreateInput>
{
    OriginId = "GHD001",           // SKU del PIM
    Reference = null,               // solo se usa en algunos casos
    Input = new ProductCreateInput { Title = "GHD Styler", ... }
}
```

El campo `Reference` se usa cuando se necesita un segundo identificador auxiliar: para variantes lleva el EAN, para imágenes puede llevar el SKU del producto.

---

### `IActivityInput` y patrones de uso

Todos los modelos de input de los loaders implementan `IActivityInput`. El patrón estándar es:

```csharp
public bool RunActivity => ProcessProducts || ProcessVariants || ...;

public void CheckAndThrowExceptions()
{
    if (/*condición inválida*/)
        throw new ArgumentException("...");
}
```

`BaseActivity<T>` evalúa `RunActivity` al inicio: si es `false`, la actividad se salta completamente. Esto permite que un transformer devuelva un input "vacío" (sin datos que procesar) y la actividad de loader no haga ninguna llamada a la API de Shopify.

---

### `ActivityResult`

```csharp
public record ActivityResult
{
    public List<string> InformationLogs = [];
    public List<string> WarningLogs = [];
    public List<string> ErrorLogs = [];
    public List<string> CriticalLogs = [];

    public void LogMe(ILogger logger, string activityName) { ... }
    public static ActivityResult operator +(ActivityResult a1, ActivityResult a2) { ... }
}
```

Es el objeto de resultado que devuelven muchos métodos internos de las actividades. Recoge mensajes de log durante la ejecución y los imprime en un bloque formateado al final, con el nivel de log apropiado (el nivel más alto de los mensajes recogidos determina el nivel del log final).

El operador `+` permite combinar resultados de múltiples sub-operaciones en un único resultado agregado.

---

## 7. Modelos de input de los loaders

Estos modelos son la "carga" que el transformer entrega al loader. Cada uno describe exactamente qué debe hacer el loader en esta ejecución.

---

### `ProductsWithVariantsCreateLoaderInput`

Para la actividad de **creación de productos**.

```
ProductsWithVariantsCreateLoaderInput
├── Products: List<(product, variants[])>?
│   └── Cada tupla: OriginInput<ProductCreateInput> + OriginInput<ProductVariantsBulkInput>[]
├── ExcludeNewProductsFromMarkets: bool (default: true)
│   └── Los productos nuevos no se publican en ningún mercado al crearse
├── PublishProducts: bool (default: false)
│   └── Publica en Shopify los productos que ya existen en BBDD
└── Variants: Dictionary<ShopifyId, OriginInput<ProductVariantsBulkInput>[]>?
    └── Para añadir variantes a productos que ya existen en Shopify
```

**`RunActivity`** es `true` si hay Products, Variants o PublishProducts=true.

---

### `ProductsWithVariantsUpdateLoaderInput`

Para la actividad de **actualización de productos**. Es el input más complejo.

```
ProductsWithVariantsUpdateLoaderInput
├── Products: List<OriginInput<ProductUpdateInput>>?
│   └── Actualiza campos del producto (título, descripción, metafields...)
├── Variants: Dictionary<ShopifyId, OriginInput<ProductVariantsBulkInput>[]>?
│   └── Clave: ShopifyId del producto. Valor: variantes a actualizar
├── RebuildProductOptions: Dictionary<ShopifyId, OriginInput<ProductVariantsBulkInput>[]>?
│   └── Reconstruye opciones del producto desde cero:
│       1. Borra todas las variantes/opciones actuales
│       2. Crea las nuevas con las opciones indicadas
├── ProductOptionsAndValuesToReorder: Dictionary<ShopifyId, Dictionary<ShopifyId, List<string>>>?
│   └── Reordena opciones y valores existentes sin borrarlos
└── InventoryItems: Dictionary<OriginId, InventoryItemInput>?
    └── Actualiza configuración de inventario de variantes
```

**`RunActivity`** es `true` si hay Products, Variants, RebuildProductOptions, ProductOptionsAndValuesToReorder o InventoryItems.

---

### `ProductsWithVariantsDeleteLoaderInput`

Para la actividad de **borrado de variantes y productos**.

```
ProductsWithVariantsDeleteLoaderInput
├── VariantsToDelete: Dictionary<ShopifyId (producto), ShopifyId[] (variantes)>?
│   └── Agrupa las variantes a borrar por producto padre
└── ProductsToDelete: List<ShopifyId>?
    └── Productos completos a borrar
```

En Shopify, borrar variantes requiere conocer el producto padre porque la mutación es `productVariantsBulkDelete(productId, variantsIds)`.

---

### `SyncStockInput`

Para la actividad de **sincronización de inventario**.

```
SyncStockInput
└── Variants: Dictionary<ShopifyId (producto), VariantStockUpdate[]>?
```

**`VariantStockUpdate`** contiene:

| Campo | Tipo | Descripción |
|---|---|---|
| `IdShopifyVariant` | ShopifyId | GID de la variante en Shopify |
| `LocationId` | string | GID de la ubicación de inventario en Shopify |
| `Stock` | int | Cantidad disponible |
| `InventoryPolicy` | ProductVariantInventoryPolicy? | `DENY` (no vender sin stock) / `CONTINUE` (vender sin stock) |
| `Metafields` | List\<MetafieldInput\>? | Metafields a actualizar con el stock |
| `MetafieldsToDelete` | List\<MetafieldIdentifierInput\>? | Metafields a borrar |

---

### `PriceListsB2BLoaderInput`

Para la actividad de **sincronización de tarifas B2B**. Es el input más rico en operaciones.

```
PriceListsB2BLoaderInput
├── PriceListsToCreate: Dictionary<string, CurrencyCode>?
│   └── Clave: nombre de la tarifa. Valor: divisa (EUR, USD...)
├── PriceListsToDelete: ShopifyId[]?
│   └── GIDs de las tarifas a eliminar
├── SetProductVariantsFixedPrices: Dictionary<OriginId, PriceListPriceInput[]>?
│   └── Clave: OriginId de la tarifa. Incluye los productos si no estaban
├── SetProductVariantsFixedPricesData: Dictionary<OriginId, PriceListPriceData[]>
│   └── Copia de los datos para registro en BBDD
├── SetProductWithZeroInPrices: bool (default: false)
│   └── Guardia de seguridad: evita poner precios a 0 accidentalmente
├── ResetProductVariantsFixedPrices: Dictionary<ShopifyId, ShopifyId[]>?
│   └── Clave: ShopifyId de la tarifa. Valor: GIDs de variantes → resetear a precio de ficha
├── ExcludeProducts: Dictionary<ShopifyId, ShopifyId[]>?
│   └── Clave: GID del producto. Valor: GIDs de tarifas de las que excluirlo
│   └── Excluir = ese producto no aparece para clientes de esas tarifas
├── QuantityPriceBreaks: Dictionary<ShopifyId, List<QuantityPriceBreakInput>>?
│   └── Precios por volumen (actualmente comentado en el transformer)
├── QuantityPriceBreaksToDelete: Dictionary<ShopifyId, ShopifyId[]>?
├── QuantityRules: Dictionary<ShopifyId, List<QuantityRuleInput>>?
└── QuantityRulesToDelete: Dictionary<ShopifyId, ShopifyId[]>?
```

---

### `TranslationsInput`

Para la actividad de **traducciones**.

```
TranslationsInput
├── ProductsToTranslate: Dictionary<ShopifyId, Dictionary<string, ProductTranslateModel>>?
│   └── Clave externa: GID del producto. Clave interna: locale (ej: "en")
└── MetafieldsToTranslate: Dictionary<ShopifyId, Dictionary<string, List<MetafieldInput>>>?
    └── Clave externa: GID del padre. Clave interna: locale. Valor: metafields traducidos
```

---

## 8. Entidades de la base de datos de transacciones

La BD `transactions-provalliance` es el corazón del sistema de sincronización. Persiste la relación `OriginId ↔ DestinoId` para cada entidad que se ha sincronizado. Sin esta BD, el sistema no podría saber qué GID de Shopify corresponde a qué código del ERP.

Todas las entidades (excepto `Order` y `PriceListVariant`) heredan de `BaseEntity`.

---

### `BaseEntity`

```csharp
public class BaseEntity
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string? Referencia { get; set; }
    public required string OrigenId { get; set; }   // max 250 chars
    public required string DestinoId { get; set; }  // max 100 chars
}
```

| Campo | Descripción | Ejemplo |
|---|---|---|
| `Id` | Clave primaria interna (GUID autogenerado) | `3f2504e0-4f89-11d3-9a0c-0305e82c3301` |
| `OrigenId` | Identificador en el sistema origen (ERP/PIM) | `"GHD001"`, `"C0001#DIR01"`, `"https://..."` |
| `DestinoId` | Identificador en Shopify (GID) | `"gid://shopify/Product/123456"` |
| `Referencia` | Dato auxiliar adicional (varía por tipo de entidad) | EAN de variante, SKU de imagen, etc. |

---

### `TipoEntidad` — enumerado de tipos de entidad

```
Producto, Opciones, Variante, VarianteImagen, Stock,
Company, Location, Customer, CompanyContact,
Imagen, PriceList, ProductoPriceList, Pedido, Rol
```

Este enumerado se usa en la entidad `Metafield` para saber a qué tipo de entidad pertenece el metafield registrado.

---

### Entidades de producto

**`Product` (BD)**
- Hereda `BaseEntity`
  - `OrigenId` = SKU del PIM (ej: `"GHD001"`)
  - `DestinoId` = GID del producto en Shopify (ej: `"gid://shopify/Product/7890123"`)
- Relaciones: `List<ProductOption>`, `List<Variant>`, `List<Media>`

**`ProductOption` (BD)**
- Hereda `BaseEntity`
  - `OrigenId` = nombre de la opción (ej: `"Talla"`)
  - `DestinoId` = GID de la opción en Shopify
  - `Referencia` = posición (1, 2 o 3)
- `Position`: int entre 1 y 3. El setter valida que sea > 0.
- FK: `ProductId → Product`

**`Variant` (BD)**
- Hereda `BaseEntity`
  - `OrigenId` = ID de variante del PIM (ej: `"GHD001#12345"`)
  - `DestinoId` = GID de la variante en Shopify
  - `Referencia` = EAN de la variante (usado por `StockTransform` para resolver el stock)
- `ShopifyInventoryItemId`: GID del inventario en Shopify — diferente al GID de la variante. Se necesita para ajustar el inventario.
- `MediaId`: FK opcional a `Media` — la imagen "principal" asignada a esta variante.
- Relaciones: `Product`, `Media?`, `List<PriceListVariant>`

**`Media` (BD)**
- Hereda `BaseEntity`
  - `OrigenId` = URL de la imagen en SalesLayer
  - `DestinoId` = GID del media en Shopify
- `Hash`: huella de la imagen (para detectar si cambió y necesita actualización).
- FK: `ProductId → Product`
- Relación inversa: `List<Variant>` (las variantes que muestran esta imagen)

---

### Entidades de cliente (jerarquía B2B)

La estructura de clientes en la BD refleja exactamente la jerarquía B2B de Shopify: **Company → Location → CompanyContact → Customer**.

**`Company` (BD)**
- Hereda `BaseEntity`
  - `OrigenId` = CodCom del ERP (ej: `"C0001"`)
  - `DestinoId` = GID de la Company en Shopify
- `DefaultRole`: GUID del rol por defecto asignado a los contactos de esta empresa.
- Relaciones: `List<Location>`, `CompanyContact? MainContact`, `List<CompanyContact> Contacts`

**`Location` (BD)**
- Hereda `BaseEntity`
  - `OrigenId` = `"{CodCom}#{Codadr}"` (ej: `"C0001#DIR01"`)
  - `DestinoId` = GID de la CompanyLocation en Shopify
- FK: `CompanyId → Company`
- Relación: `List<Rol>` (qué contactos tienen acceso a esta location)

**`Customer` (BD)**
- Hereda `BaseEntity`
  - `OrigenId` = email del cliente (ej: `"garcia@peluqueria.es"`)
  - `DestinoId` = GID del Customer en Shopify
- `IsAgent`: bool — si este cliente es un agente comercial.
- Relación inversa: `CompanyContact?`

**`CompanyContact` (BD)**
- Une un `Customer` con una o más `Company`.
- `CompanyAsMainContactId`: si este contacto es el contacto principal de una Company.
- `CompanyAsContactId`: si este contacto es un contacto adicional de una Company.
- FK: `CustomerId → Customer`
- Relaciones: `List<Rol>` (qué Locations puede acceder)

**`Rol` (BD)**
- Hereda `BaseEntity`
  - `OrigenId` = `"{locationOriginId}-{customerOriginId}"` (ej: `"C0001#DIR01-garcia@peluqueria.es"`)
  - `DestinoId` = GID del rol en Shopify
- Es la asignación de un `CompanyContact` a una `Location`.
- FK: `LocationId → Location`, `ContactId → CompanyContact`

---

### Entidades de tarifa

**`PriceList` (BD)**
- Hereda `BaseEntity`
  - `OrigenId` = código de tarifa del ERP
  - `DestinoId` = GID de la PriceList en Shopify
- `CatalogId`: GID del catálogo de Shopify asociado (puede ser null).
- `PublicationId`: GID de la publicación de Shopify — necesario para dar acceso a los productos de la tarifa.
- Relaciones: `List<PriceListVariant>`

**`PriceListVariant` (BD)**

No hereda `BaseEntity`. Registra el precio que una variante tiene en una tarifa:

| Campo | Tipo | Descripción |
|---|---|---|
| `Id` | Guid | Clave primaria |
| `Amount` | decimal | El precio almacenado en BD (para comparar con el del ERP en la próxima sincronización) |
| `VariantId` | Guid | FK → Variant |
| `PriceListId` | Guid | FK → PriceList |
| `Data` | string? | Datos adicionales en JSON (no usado actualmente) |

Cuando `PriceListTransform` compara los precios actuales con los del ERP, usa `Amount` para saber si el precio ha cambiado y necesita actualizarse, o si ya es correcto.

---

### Entidades de pedido y otros

**`Order` (BD)**

No hereda `BaseEntity`. Estructura propia:

| Campo | Tipo | Descripción |
|---|---|---|
| `Id` | Guid | Clave primaria |
| `ErpId` | string (max 100) | Identificador en el ERP |
| `ShopifyId` | string (max 100) | GID del pedido en Shopify |
| `Referencia` | string? | Referencia adicional |
| `Estado` | EnumOrderState | Estado del ciclo de vida del pedido |

Estados del pedido: `CREADO → PAGADO → ENVIADO_PARCIAL → ENVIADO → ENTREGADO` (o `CANCELADO` desde cualquier estado).

**`Metafield` (BD)**
- Hereda `BaseEntity`
  - `OrigenId` = identificador del metafield en el sistema origen
  - `DestinoId` = GID del metafield en Shopify
- `EntityId`: Guid — referencia al ID de la entidad padre (producto, variante, etc.)
- `Tipo`: TipoEntidad — qué tipo de entidad es el padre

---

## Cómo se relacionan todos los modelos

```
Origen (ERP/PIM)          Dominio                   BD Transacciones
──────────────────────    ──────────────────────    ──────────────────────────
SalonSpaceProduct     →   Product / Variant     →   Product + Variant + Media
ClientResponseModel   →   ICompany              →   Company + Location + Customer + CompanyContact + Rol
Stock struct          →   (sin transformación)   →   (usa Variant.Referencia=EAN)
Order (Shopify)       →   OrderModel            →   Order
IPriceList            →   (sin BD propia)        →   PriceList + PriceListVariant

                          Intermedios
                          ──────────────────────
                          Box<T>         → envuelve listas para Elsa
                          OriginInput<T> → une ERP ID con Shopify input
                          *LoaderInput   → instrucciones para el loader
                          ActivityResult → resultado acumulado de logs
```

El flujo de datos completo de una sincronización de productos es:

```
SalonSpaceProduct[] (PIM)
  └─ construye → Product[] + Variant[]
       └─ transformer lee → IProduct / IVariant
            └─ transformer produce → ProductsWithVariantsCreateLoaderInput
                 │   (contiene OriginInput<ProductCreateInput>)
                 │   (contiene OriginInput<ProductVariantsBulkInput>[])
                 └─ loader crea en Shopify → recibe GIDs
                      └─ loader registra en BD → Product(OrigenId, DestinoId)
                                              → Variant(OrigenId, DestinoId, Referencia=EAN)
                                              → Media(OrigenId, DestinoId)
```

---

## Siguiente paso

→ [`07-infraestructura.md`](07-infraestructura.md) — Docker Compose, contenedores y variables de entorno
