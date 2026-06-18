# 04b — Extractors: detalle completo de cada uno

Este documento entra en profundidad en cada extractor: qué objeto produce, cómo llega del sistema origen, cuál es su estructura campo a campo y qué transformaciones iniciales aplica el propio extractor antes de entregar los datos.

---

## Extractor 1 — Productos e imágenes del PIM (`ProductsWithImagesExtract`)

### Sistema origen
**SalesLayer** — PIM (Product Information Manager). Se accede mediante el conector `UPG.Connector.SalesLayer`, usando el canal de salida configurado en `PIM:CanalSalida`.

### Cómo llega la respuesta

SalesLayer devuelve un único objeto JSON con dos listas:

```json
{
  "categories": [ { ... }, { ... } ],
  "products":   [ { ... }, { ... }, { ... } ]
}
```

Esto se deserializa en `SalonSpaceResponse`:

```csharp
public class SalonSpaceResponse
{
    public List<SalonSpaceCategory> Categories { get; set; }
    public List<SalonSpaceProduct>  Products   { get; set; }
}
```

La lista de categorías no se usa en el flujo actual. Todo el procesamiento es sobre `Products`.

---

### La estructura de `SalonSpaceProduct` — campo a campo

Cada elemento de la lista `products` es un `SalonSpaceProduct`. Esta clase tiene más de 80 campos porque el PIM almacena una cantidad enorme de atributos de producto. Los más relevantes:

#### Identificación

| Campo JSON | Propiedad C# | Descripción |
|---|---|---|
| `ID` | `Id` | Identificador interno de SalesLayer. Se usa como sufijo del `OriginId` de la variante. |
| `sku` | `Sku` | Referencia del artículo. Para productos simples, es el `OriginId` del producto. |
| `ean` | `Ean` | Código EAN principal. El `StockExtract` usa el EAN para cruzar con el stock. |
| `ean_1`, `ean_2`, `ean_3` | `Ean1`, `Ean2`, `Ean3` | EANs alternativos. |
| `codigo_agrupacion` | `CodigoAgrupacion` | Si está relleno, el artículo es una variante y este es el `OriginId` del producto padre. Si está vacío, es un producto simple. |
| `STATUS` | `Status` | Estado interno de SalesLayer (no es el estado de publicación). |

#### Estado de publicación

| Campo JSON | Propiedad C# | Tipo | Valores |
|---|---|---|---|
| `estatus` | `Estatus` | `Estatus` (enum) | `Visible`, `Invisible`, `Borrador` |
| `obsoleto` | `Obsoleto` | `bool` | `true`/`false` (viene como `"1"`/`"0"` o `""` en el JSON) |

El `Estatus` se mapea a `EntityStatus` en la variante:

```
Visible   → EntityStatus.Active
Borrador  → EntityStatus.Inactive
Invisible → EntityStatus.Deleted
```

Y el extractor aplica una regla especial antes de eso: si `Estatus == Visible && Obsoleto == true`, fuerza `Estatus = Invisible`. Un producto visible pero obsoleto se trata como eliminado.

#### Agrupación de variantes

| Campo JSON | Propiedad C# | Descripción |
|---|---|---|
| `agrupacion` | `Agrupacion` | Lista con la definición de opciones. Ejemplo: `["Color + Talla"]`. Los nombres de las opciones se extraen separando por `+`. |

Este campo sólo tiene sentido en el artículo "padre" (el que tiene el mismo SKU que `codigo_agrupacion`). Los demás artículos del grupo usarán los atributos referenciados ahí para extraer el valor de cada opción.

#### Contenido traducible

Muchos campos son de tipo `Translatable<string>`, que es una clase del conector SalesLayer que almacena el mismo texto en varios idiomas:

```csharp
// Ejemplo de uso:
producto.NombreProducto.Get("es")  // → "Champú hidratante"
producto.NombreProducto.Get("en")  // → "Moisturizing shampoo"
```

Los campos traducibles son:

| Campo JSON | Descripción |
|---|---|
| `nombre_producto` | Nombre del producto |
| `long_product_description` | Descripción larga |
| `short_product_description` | Descripción corta |
| `parent_product_name` | Nombre del producto padre (para variantes) |
| `how_to_use` | Modo de uso |
| `key_features` | Características principales |
| `benefits` | Beneficios |
| `additional_benefits` | Beneficios adicionales |
| `ingredients` | Ingredientes |
| `hair_type` | Tipo de cabello |
| `color` | Color |
| `meta_title` | Título meta (SEO) |
| `meta_description` | Descripción meta (SEO) |
| `descripcion_profesional` | Descripción de uso profesional |

#### Clasificación y taxonomía

Hay una cantidad muy grande de campos de clasificación (todos de tipo `string`) que reflejan la taxonomía de productos del sector de peluquería:

```
shopify_category, shopify_subcategory, shopify_linea_marca,
brand, brand_family, brand_subfamily, brand_line,
tipo_lacas_styling_lacas, tipo_cera_styling_ceras,
tipo_producto_cabello_champus, tipo_producto_cabello_mascarillas,
tipo_producto_color_tintes, tipo_producto_color_tintes_negros, ...
```

Estos campos existen porque la taxonomía del catálogo de Provalliance es muy específica del sector (peluquería, cosmética, accesorios). No todos tienen valor en todos los productos: la mayoría estará vacío dependiendo de la categoría del artículo.

#### Imágenes

| Campo JSON | Propiedad C# | Descripción |
|---|---|---|
| `imagen_de_producto` | `Imagenes` | Imágenes propias de la variante (lista de URLs). |
| `imagen_productos_agrupados` | `ImagenesProductosAgrupados` | Imágenes del producto padre, compartidas por todas las variantes. |

Las URLs vienen como objetos `SLUri` con una propiedad `.Org` que contiene la URL original de la imagen en alta resolución.

#### Otros campos relevantes

| Campo JSON | Propiedad C# | Descripción |
|---|---|---|
| `etiqueta` | `Etiqueta` | Tags del producto (lista de strings). Se trasladan a tags de Shopify. |
| `sku_type` | `SkuType` | Tipo de SKU. |
| `content_value` + `content_type` | — | Contenido y tipo (ej: "250" + "ml"). |
| `weight` | `Weight` | Peso del artículo. |
| `salon_space_selling_price` | `SalonSpaceSellingPrice` | Precio de venta (string, hay que parsear). |
| `nivel_impuesto` | `NivelImpuesto` | Nivel de impuesto (IVA). |
| `ficha_tecnica` | `FichaTecnica` | URL a la ficha técnica. |

---

### De `SalonSpaceProduct` a `Product` y `Variant`

El extractor no entrega los `SalonSpaceProduct` directamente. Los convierte en objetos `Product` (que implementa `IProduct`) y `Variant` (que implementa `IVariant`).

#### El objeto `Product`

```csharp
public class Product : IProduct
{
    public string OriginId { get; }        // = CodigoAgrupacion (o Sku si es simple)
    public EntityStatus Status { get; }    // calculado a partir de las variantes
    
    // Internamente:
    private readonly ICollection<Variant> _variants;
    private readonly Variant _mainVariant;  // el que tiene el mismo Sku que CodigoAgrupacion
}
```

El `Status` del producto se calcula como el "mínimo" de las variantes: si alguna está `Active`, el producto está `Active`. Si están todas `Inactive`, el producto está `Inactive`. Etc.

El `OriginId` del producto es:
- **Producto simple**: el campo `Sku` del artículo.
- **Producto con variantes**: el campo `CodigoAgrupacion` (el SKU padre compartido).

#### El objeto `Variant`

```csharp
public class Variant : IVariant
{
    public string ProductOriginId { get; }  // = OriginId del producto padre
    public string OriginId { get; }         // = "{ProductOriginId}#{SalonSpaceProduct.Id}"
    public EntityStatus Status { get; }     // calculado desde Estatus del SalonSpaceProduct
    public IDictionary<string, string>? Options { get; set; }  // ej: {"Color": "Negro", "Talla": "M"}
}
```

El `OriginId` de cada variante es un identificador compuesto: el ID del producto padre más el ID interno de SalesLayer, separados por `#`. Esto garantiza unicidad global.

#### Cómo se construyen las opciones (`Options`)

- **Producto simple** (1 variante): la opción es siempre `{"Title": "Default Title"}` (convención de Shopify).
- **Producto con variantes**: se leen los nombres de opciones del campo `Agrupacion` del artículo padre (ej: `"Color + Talla"`) y se parte por `+`. Para cada variante, se lee el valor de cada opción buscando en el objeto `SalonSpaceProduct` el campo JSON que coincida con el nombre de la opción en minúsculas con guiones bajos (ej: `color`, `talla`).

---

### El objeto `ProductImage`

```csharp
public class ProductImage : IProductImage
{
    public string ImageOriginId         { get; }  // URL de la imagen (es a la vez su ID)
    public string ProductOriginId       { get; }  // OriginId del producto al que pertenece
    public List<string>? ProductVariantsOriginId { get; }  // OriginIds de las variantes con esa imagen
}
```

Hay dos tipos de imágenes:
- **Imágenes de variante** (`imagen_de_producto`): tienen `ProductVariantsOriginId` relleno con las variantes que usan esa imagen.
- **Imágenes de producto padre** (`imagen_productos_agrupados`): tienen `ProductVariantsOriginId` vacío, aplican a todo el producto.

---

## Extractor 2 — Clientes del ERP (`CustomerExtract`)

### Sistema origen
**API de Provalliance** — middleware en Azure API Management. Endpoint: `GET /clients/client?PageNumber=0&PageItems=50`.

### Cómo llega la respuesta (paginada)

Cada página devuelve un `ClientResponseModelContainer`:

```json
{
  "ClientsList": [ { ... }, { ... } ],
  "NextPageLink": "https://apim-prod.../clients/client?PageNumber=1&PageItems=50"
}
```

```csharp
public class ClientResponseModelContainer
{
    public List<ClientResponseModel> ClientsList { get; set; }
    public string NextPageLink { get; set; }
}
```

El extractor itera páginas hasta recibir una con menos de 50 elementos.

---

### La estructura de `ClientResponseModel` — campo a campo

Los campos de la API de Provalliance usan nombres crípticos heredados del ERP (Sage X3). Cada campo principal es un objeto con el nombre de la tabla del ERP.

```csharp
public class ClientResponseModel : ICompany
{
    [JsonProperty("BPC0_1")]  public CompanyResponseModel Company   { get; set; }
    [JsonProperty("BPRC_1")]  public Bprc1                Bprc1     { get; set; }
    [JsonProperty("BPRC_5")]  public Bprc5                Bprc5     { get; set; }
    [JsonProperty("BPAC_1")]  public LocationResponseModel[] Locations { get; set; }
    [JsonProperty("BPC2_6")]  public Bpc26                Bpc26     { get; set; }
    [JsonProperty("BPC3_1")]  public Bpc31                Bpc31     { get; set; }
    [JsonProperty("BPC3_2")]  public ZonaFiscal           ZonaFiscal { get; set; }
    [JsonProperty("BPC3_3")]  public Bpc33                Bpc33     { get; set; }
    [JsonProperty("BPC4_1")]  public Bpc41[]              Bpc41     { get; set; }
    [JsonProperty("ADXTEC")]  public Adxtec               Adxtec    { get; set; }
}
```

#### `BPC0_1` → `CompanyResponseModel` — datos de la empresa

| Campo JSON | Campo C# | Descripción |
|---|---|---|
| `BPCNUM` | `CodCom` | **Código de cliente en el ERP. Es el `OriginId` de la Company en Shopify.** |
| `BPCNAM` | `Name` | Razón social de la empresa. |
| `BCGCOD` | `Bcgcod` | Código de grupo de clientes. |
| `ZBPCSHOPIFY` | `Zbpcshopify` | ID de Shopify (si ya fue sincronizado). |

#### `BPRC_1` → `Bprc1` — datos de facturación y financieros

| Campo JSON | Significado |
|---|---|
| `CRN` | **Número de IVA / CIF.** Se copia a todas las Locations. |
| `CUR` | Moneda del cliente. |
| `LAN` | Idioma del cliente. |
| `BPRSHO` | Nombre abreviado. |
| `ZUTOFAC` | Indicador de facturación automática. |
| `SUBTOTAX` | Tipo de IVA. |

#### `BPRC_5` → `Bprc5` — datos EDI

| Campo JSON | Significado |
|---|---|
| `ZEDIFLG` | Flag de integración EDI activa. |
| `ZEDIREF` | Referencia EDI del cliente. |

#### `BPAC_1` → `LocationResponseModel[]` — **las direcciones**

Este es el campo más importante. Es un array de direcciones del cliente. Cada dirección implementa a la vez `ILocation` **y** `ICustomer`, porque en el modelo de Shopify B2B cada dirección es tanto una sucursal como una persona de acceso.

##### Campos de `LocationResponseModel`

| Campo JSON | Campo C# | Significado en Shopify |
|---|---|---|
| `CODADR` | `Codadr` | Código de dirección en el ERP |
| `BPADES` | `Contact` | Nombre de la persona de contacto |
| `BPACRY` | `Country` | Código de país (2 letras, ej: `ES`) |
| `ADDLIG1` | `Address1` | Primera línea de dirección |
| `ADDLIG2` | `Address2` | Segunda línea de dirección |
| `POSCOD` | `Zip` | Código postal |
| `CTY` | `City` | Ciudad |
| `SAT` | `ZoneCode` | Código de provincia/estado |
| `TEL1` | `Phone` | Teléfono principal |
| `WEB1` | `Email` | **Email del contacto. Es el `OriginId` del Customer en Shopify.** |

##### Los dos OriginId de `LocationResponseModel`

La misma clase actúa como dos entidades distintas en Shopify, con dos `OriginId` diferentes:

```csharp
// Como ILocation (sucursal):
string ILocation.OriginId => LocationOriginId;
// Valor: "{CodCliente}#{CodDireccion}"  →  ej: "C0001#DIR01"
// Se construye en CustomerExtract: location.LocationOriginId = cliente.OriginId + "#" + location.Codadr

// Como ICustomer (contacto/persona de acceso):
string ICustomer.OriginId => Email;
// Valor: el email del contacto  →  ej: "contacto@peluqueria.com"
```

Esto es fundamental: **el email es el identificador único del contacto en Shopify**. Si dos direcciones del mismo cliente tienen el mismo email, el sistema las trata como el mismo contacto.

#### `BPC3_2` → `ZonaFiscal` — zona fiscal

| Campo JSON | Campo C# | Descripción |
|---|---|---|
| `VACBPR` | `zonaFiscal` | Código de zona fiscal. Ejemplos: `EXE` (exento), `es_re:REQ` (recargo de equivalencia), cualquier otro valor (régimen normal). |
| `VATEXN` | `Vatexn` | Número de exención de IVA. |

Este campo se guarda como metafield en la Company de Shopify (`upng.zona_fiscal`).

#### `BPC3_1` → `Bpc31` — datos de pago

Contiene información sobre el pagador (`BPCINV`, `BPCPYR`) y el grupo de clientes (`BPCGRU`). No se usa directamente en la sincronización actual.

#### `ADXTEC` → `Adxtec` — auditoría

| Campo JSON | Significado |
|---|---|
| `WW_MODSTAMP` | Timestamp de última modificación (útil para sincronizaciones incrementales) |
| `WW_MODUSER` | Usuario que hizo la última modificación |

---

### Lo que produce `CustomerExtract`

Entrega una `Box<ICompany>` donde cada elemento es un `ClientResponseModel`. Desde el punto de vista del sistema:

```
ClientResponseModel (ICompany)
  · OriginId = Company.CodCom              → ej: "C0001"
  · GetLocations() = Locations[]           → array de LocationResponseModel como ILocation
  · GetCustomers() = Locations[]           → mismo array como ICustomer
  · GetMainContact() = Locations.First()   → la primera dirección es el contacto principal
  · GetFiscalZone() = ZonaFiscal.zonaFiscal
```

---

## Extractor 3 — Stock del ERP (`StockExtract`)

### Sistema origen
**API de Provalliance** — endpoint: `GET /stock/shopify`.

### Cómo llega la respuesta

La API devuelve directamente un array JSON:

```json
[
  { "ean": "8432599123456", "warehouse": "MADRID", "quantity": 42 },
  { "ean": "8432599654321", "warehouse": "MADRID", "quantity": 0  },
  ...
]
```

### El objeto `Stock`

```csharp
public struct Stock
{
    [JsonProperty("ean")]       public string Ean      { get; init; }
    [JsonProperty("warehouse")] public string Warehouse { get; init; }
    [JsonProperty("quantity")]  public int    Quantity  { get; init; }
}
```

| Campo | Descripción |
|---|---|
| `Ean` | Código EAN de la variante. Es el puente entre el ERP y Shopify: el transformer lo usará para buscar en la BD de transacciones a qué `InventoryItemId` de Shopify corresponde este EAN. |
| `Warehouse` | Almacén del que proviene el stock. Actualmente no se usa para filtrar. |
| `Quantity` | Cantidad disponible. Si es 0, la variante quedará a 0 en Shopify. |

### Lo que produce `StockExtract`

Entrega una `Box<Stock>` con todos los registros sin ningún filtrado adicional.

---

## Extractor 4 — Pedidos de Shopify (`OrdersExtractor`)

### Sistema origen
**Shopify** — accedido a través del `ShopifySDK`. Método: `Orders.Retrieve(query)`.

### Cómo llega la respuesta

El SDK ejecuta una query de la API de Shopify usando el filtro de configuración. El filtro por defecto es `tag_not:Sincronizado`, que devuelve todos los pedidos que no tienen esa etiqueta. El resultado es una lista de objetos `Order` del SDK de Shopify.

El objeto `Order` de Shopify es complejo y contiene toda la información del pedido tal como existe en Shopify. Los campos más relevantes para este proyecto son:

```
Order
  · Id           → ID de GraphQL del pedido en Shopify  (ej: "gid://shopify/Order/123456")
  · Name         → Nombre legible del pedido            (ej: "#SS4185")
  · LineItems    → Nodos con las líneas del pedido
  │   └── Nodes[]
  │         · Quantity    → Cantidad pedida
  │         · Title       → Nombre del producto
  │         · Variant     → Referencia a la variante
  └── BuyerIdentity
        └── PurchasingCompany
              · Company   → Company de Shopify B2B
              │   └── ExternalId  → El OriginId del cliente en el ERP (= CodCom)
              └── Location → Sucursal desde la que se hizo el pedido
```

El campo clave es `ExternalId` de la Company: es el metafield que se estableció durante la sincronización de clientes y contiene el código de cliente del ERP (`CodCom`). Sin él, el pedido no puede enviarse al ERP y se descarta.

### Lo que produce `OrdersExtractor`

Entrega una `Box<Order>` con los pedidos en crudo tal como vienen de Shopify. La conversión al modelo del ERP se hace en el paso de transformación siguiente.

### Lo que hace `OrderTransform` inmediatamente después

Aunque no es un extractor, es relevante entender qué pasa justo después:

```csharp
// Para cada Order de Shopify:
var company = order.GetCompanyDetailsForCustomer()?.Company;
var customerId = company?.ExternalId;   // ← el CodCom del ERP
if (string.IsNullOrWhiteSpace(customerId)) return null;  // descarta si no tiene ExternalId
```

Produce `OrderModel`, que es un objeto contenedor que une el `Order` de Shopify con el `OrderHeaderModel` (formato ERP):

```csharp
public class OrderModel
{
    public Order ShopifyOrder { get; }         // el pedido original de Shopify
    public OrderHeaderModel Header { get; }    // el pedido convertido al formato del ERP
    public ICollection<OrderLineModel> Lines { get; }  // las líneas del pedido
}
```

---

### El objeto `OrderHeaderModel` — formato del ERP

```csharp
public class OrderHeaderModel
{
    [JsonProperty("id")]                 string  Id               // Número de pedido ERP
    [JsonProperty("shopifyId")]          string  ShopifyId        // ID de Shopify
    [JsonProperty("created_at")]         string? CreatedAt        // Fecha de creación
    [JsonProperty("ejercicioDocumento")] int     EjercicioDocumento // Año fiscal
    [JsonProperty("customerId")]         string? CustomerId       // CodCom del ERP
    [JsonProperty("shippingAddressId")]  string? ShippingAddressId // CodAdr del ERP
    [JsonProperty("paymenTerms")]        string? PaymentTerms     // Términos de pago
    [JsonProperty("shippingLineCode")]   string? ShippingLineCode  // Código de envío
    [JsonProperty("shippingLinePrice")]  decimal? ShippingLinePrice // Precio de envío
    [JsonProperty("subtotalPrice")]      decimal? SubtotalPrice   // Subtotal
    [JsonProperty("taxLine")]            decimal? TaxLine         // Impuestos
    [JsonProperty("totalPrice")]         decimal? TotalPrice      // Total
    [JsonProperty("totalDiscount")]      decimal? TotalDiscount   // Descuento total
    [JsonProperty("totalDiscountPrcnt")] decimal? TotalDiscountPrcnt // Descuento %
    [JsonProperty("note")]               string? Note             // Notas del pedido
    [JsonProperty("poNumber")]           string? PoNumber         // Número de PO
    [JsonProperty("shipping_address")]   OrderShippingAddressModel? ShippingAddress
    [JsonProperty("line_items")]         ICollection<OrderLineModel>? LineasDocumento
}
```

### El objeto `OrderLineModel` — líneas del pedido

```csharp
public class OrderLineModel
{
    [JsonProperty("price")]              decimal  Price          // Precio unitario
    [JsonProperty("quantity")]           int      Quantity       // Cantidad
    [JsonProperty("productId")]          string   ProductId      // Referencia del producto (OriginId en el ERP)
    [JsonProperty("title")]              string   Title          // Nombre del artículo
    [JsonProperty("totalDiscount")]      decimal  TotalDiscount  // Descuento de línea
    [JsonProperty("totalDiscountPrcnt")] decimal? TotalDiscountPrcnt // Descuento %
    [JsonProperty("totalPrice")]         decimal  TotalPrice     // Total de línea
}
```

### El objeto `OrderShippingAddressModel` — dirección de envío

```csharp
public class OrderShippingAddressModel
{
    string? FirstName, LastName    // Nombre y apellido del destinatario
    string? Address1, Address2     // Líneas de dirección
    string? City, Zip              // Ciudad y código postal
    string? Province, ProvinceCode // Provincia
    string? Country, CountryCode   // País
    string? Phone                  // Teléfono
}
```

---

## Extractor 5 — Imágenes del FTP (`LocalImagesExtractor`)

### Sistema origen
**Servidor FTP** — accedido mediante la librería `FluentFTP`. Configurado en `appsettings.json` bajo `FtpImages`.

### Proceso de extracción

1. Se conecta al FTP con usuario y contraseña.
2. Lista recursivamente todos los ficheros de las carpetas remotas configuradas.
3. Excluye el fichero `CSV_CargaImages.csv` (es el que él mismo genera).
4. Si hay prefijos configurados en `FileNameStartsWith`, excluye los ficheros que no empiecen por alguno de ellos.

### Convención de nombrado

El nombre del fichero codifica dos datos:

```
GHD001-3.jpg
  │      │
  │      └── Orden de visualización (último segmento tras el último guión)
  └───────── Referencia del producto (todo lo que va antes del último guión)
```

Ejemplos:
- `GHD-ALISADOR-PROFESSIONAL-2.png` → referencia `GHD-ALISADOR-PROFESSIONAL`, orden `2`
- `SECHE-VITE-1.jpg` → referencia `SECHE-VITE`, orden `1`
- `OLAPLEX007.jpg` → referencia `OLAPLEX007`, orden `0` (sin guión → orden por defecto 0)

### El objeto `NasFile`

```csharp
public class NasFile
{
    public string Name     { get; set; }  // Nombre del fichero con extensión.  ej: "GHD001-1.jpg"
    public string Folder   { get; set; }  // Carpeta remota donde está.         ej: "/smartie/sync_erp/images/import/new"
    public string FullPath { get; set; }  // Ruta completa en el FTP.           ej: "/smartie/sync_erp/images/import/new/GHD001-1.jpg"
    public string Reference{ get; set; }  // Referencia del producto.           ej: "GHD001"
    public string Orden    { get; set; }  // Orden de visualización como string. ej: "1"
}
```

### El CSV que genera como efecto secundario

Además de extraer los ficheros, el extractor genera y sube al FTP un fichero `CSV_CargaImages.csv`:

```csv
Imagen
GHD001-1.jpg
GHD001-2.jpg
SECHE-VITE-1.jpg
...
```

Este CSV lo lee el PIM (SalesLayer) automáticamente para asociar imágenes a productos. La columna se llama `Imagen` porque ese es el nombre que tiene el campo en el schema de SalesLayer configurado para Provalliance.

### Lo que produce `LocalImagesExtractor`

Entrega una `Box<NasFile>` con todos los ficheros encontrados. El workflow de Imágenes PIM actualmente termina aquí (con un `Finish`). La integración completa con SalesLayer está pendiente.

---

## Extractor 6 — Traducciones (`TranslationsExtract`)

### Sistema origen
No llama a ninguna API. Recibe como **input** la lista de `IProduct` ya extraída por `ProductsWithImagesExtract`.

### Qué hace

Filtra los productos que implementen la interfaz `ITranslatable`:

```csharp
List<ITranslatable> translations = _productos.OfType<ITranslatable>().ToList();
```

El tipo `ITranslatable` indica que el objeto tiene contenido en varios idiomas que puede sincronizarse en Shopify (por ejemplo, nombre y descripción en español e inglés).

### Estado actual

Existe la actividad pero no hay ningún workflow activo que la use. Es un punto de extensión preparado para cuando se implemente la sincronización de traducciones de productos en Shopify. Los campos `Translatable<string>` de `SalonSpaceProduct` (nombre, descripción, etc.) están listos para alimentarlo.

### Lo que produce `TranslationsExtract`

Entrega una `Box<ITranslatable>` con los productos que tienen contenido multilingüe.

---

## Extractor 7 — Tarifas de precios (`ExtractTarifas`)

### Estado
**Stub no implementado.** El método `RunAsync` siempre devuelve una lista vacía:

```csharp
PriceLists.Set(context, new Box<IPriceList>(new List<IPriceList>()));
```

### Por qué existe

Las tarifas de precio (`PriceList`) son necesarias en el contexto B2B de Shopify: cada sucursal (`CompanyLocation`) tiene asignada una tarifa que determina los precios que ve ese cliente. La clase `ExtractTarifas` estaba pensada para leer esas tarifas desde el ERP.

Sin embargo, en la implementación actual las tarifas se gestionan de otra forma: el workflow de Clientes incluye un paso `SyncPriceLists` que sincroniza las tarifas leyéndolas directamente desde Shopify y guardándolas en la BD de transacciones. La extracción desde el ERP quedó obsoleta antes de implementarse.

---

## Extractor 8 — Migración desde Shopify (`ShopifyExtract`)

### Estado
**Desactivado permanentemente** mediante `ShouldRunAsync() => false`.

### Para qué se usó

Al arrancar el proyecto, Shopify ya tenía productos y variantes que habían sido creados manualmente o por otro sistema. La BD de transacciones estaba vacía — no sabía qué había en Shopify ni qué `OriginId` del ERP correspondía a cada elemento.

Este extractor se usó en la puesta en marcha para **poblar la BD de transacciones desde Shopify**:

1. Descargó todos los productos y variantes de Shopify mediante una query bulk.
2. Para cada producto y variante, leyó el metafield `originId` (que contiene el código del ERP).
3. Registró en la BD de transacciones la relación `DestinoId` (ID en Shopify) ↔ `OrigenId` (código en el ERP).

### Qué hace internamente

El resultado de Shopify viene como una lista de objetos genéricos (`JObject`). El extractor los clasifica leyendo el prefijo del campo `id`:
- `gid://shopify/Product/...` → es un producto
- `gid://shopify/ProductVariant/...` → es una variante
- `gid://shopify/Metafield/...` → es un metafield

Luego cruza los metafields `originId` con productos y variantes para obtener los pares `OriginId ↔ DestinoId` que guarda en la BD.

### Por qué se conserva en el código

Se mantiene por si en algún momento hace falta repetir una migración inicial: si se borra la BD de transacciones, o si se hace una instalación nueva en otro cliente. Está desactivado pero disponible.

---

## Resumen de objetos que produce cada extractor

| Extractor | Objeto de salida | Interfaz que implementa | Siguiente paso |
|---|---|---|---|
| `ProductsWithImagesExtract` | `Box<Product>` | `IProduct` (+ `IVariant` internamente) | `ProductsRebuildDecision` |
| `ProductsWithImagesExtract` | `Box<ProductImage>` | `IProductImage` | `ImageDecision` |
| `CustomerExtract` | `Box<ClientResponseModel>` | `ICompany` (+ `ILocation` + `ICustomer` en Locations) | `CustomerDecision` |
| `StockExtract` | `Box<Stock>` | — (struct) | `StockTransform` |
| `OrdersExtractor` | `Box<Order>` | — (modelo Shopify) | `OrderTransform` |
| `LocalImagesExtractor` | `Box<NasFile>` | — | `Finish` (workflow incompleto) |
| `TranslationsExtract` | `Box<ITranslatable>` | `ITranslatable` | — (sin workflow activo) |
| `ExtractTarifas` | `Box<IPriceList>` (vacío) | `IPriceList` | — (no implementado) |
| `ShopifyExtract` | — (escribe en BD directamente) | — | — (desactivado) |
