---
tags:
  - Extractors
  - ERP
  - PIM
---

# 04 — Los Extractors

Los extractors son la primera capa del patrón ETL. Su única responsabilidad es **leer datos del sistema origen** y devolverlos en un modelo intermedio que el resto del sistema pueda procesar. No transforman, no deciden, no escriben.

En este proyecto hay extractors que leen de tres orígenes distintos:
- La **API REST de Provalliance** (middleware en Azure API Management)
- El **PIM SalesLayer** (a través del conector UPG.Connector.SalesLayer)
- **Shopify** (a través del ShopifySDK)
- Un **servidor FTP** (para imágenes)

> **¿Quieres entender cómo funciona un método concreto?**
> → [`04c-extractors-metodos.md`](04c-extractors-metodos.md) — explicación paso a paso de cada función y método de esta capa.

---

## Cómo se autentica cada origen

Antes de ver cada extractor, conviene entender cómo se autentica cada sistema, porque es el primer paso que ocurre en cualquier llamada.

### Autenticación con Provalliance — OAuth2 con `client_credentials`

La API de Provalliance está detrás de **Azure API Management**. Para acceder hay que obtener primero un token Bearer mediante el flujo OAuth2 `client_credentials`.

Esto lo gestiona [`ProvallianceAuthenticationHelperService`](04c-extractors-metodos.md#3-provallianceauthenticationhelperservice):

```text
1. Primera llamada → POST a la URL de autenticación de Azure AD
   con client_id, client_secret, resource y scope

2. Azure AD devuelve un token Bearer con tiempo de expiración (expires_on)

3. El servicio guarda el token en memoria (_authentication)

4. En cada petición posterior, comprueba si el token ha expirado:
   · Si no ha expirado → reutiliza el token
   · Si ha expirado → vuelve a autenticarse automáticamente

5. Añade el token como cabecera: Authorization: Bearer <token>
   Y también: Ocp-Apim-Subscription-Key: <subscription_key>
```

La segunda cabecera (`Ocp-Apim-Subscription-Key`) es el identificador de suscripción de Azure API Management, que permite identificar qué aplicación cliente está haciendo la petición.

### Autenticación con SalesLayer — API Key por canal

SalesLayer usa autenticación simple por **API Key**. El proyecto configura dos canales independientes:

```json
"PIM": {
  "CanalEntrada": { "ChannelId": "...", "APIKey": "..." },
  "CanalSalida":  { "ChannelId": "...", "APIKey": "..." }
}
```

- **CanalSalida**: el que usan los extractors (leer datos del PIM).
- **CanalEntrada**: el que usan los loaders (escribir datos en el PIM).

### Autenticación con Shopify — Access Token

Shopify usa tokens de acceso privados. Se configuran en `appsettings.json` bajo `ShopifyCredentials:AccessTokens` como una lista, para poder usar múltiples tokens y gestionar el throttling mediante el `LeakyBucketExecutionPolicy` del SDK.

---

## Extractor 1 — Productos e imágenes del PIM

**Clase**: `ProductsWithImagesExtract`
**Fichero**: `Extractors/ProductsWithImagesExtract.cs`
**Origen**: SalesLayer (canal de salida)
**Usado en**: Workflow de Productos, Workflow de Imágenes Shopify

### Qué hace

Llama al canal de salida de SalesLayer para obtener el catálogo completo de productos. A partir de la respuesta, construye dos listas independientes:
- Una lista de `IProduct` (productos con sus variantes agrupadas)
- Una lista de `IProductImage` (imágenes de todos los productos)

### La lógica de agrupación de variantes

SalesLayer devuelve todos los artículos "planos" como una lista. Los artículos con el mismo `CodigoAgrupacion` son variantes del mismo producto. El extractor los agrupa:

```text
SalesLayer devuelve:
  · SKU: GHD001-NEGRO,   CodigoAgrupacion: GHD001
  · SKU: GHD001-BLANCO,  CodigoAgrupacion: GHD001
  · SKU: GHD002,         CodigoAgrupacion: (vacío)

El extractor produce:
  · Product("GHD001", variantes: [GHD001-NEGRO, GHD001-BLANCO])  ← producto con variantes
  · Product("GHD002", variantes: [GHD002])                        ← producto simple
```

### Limpieza de datos antes de entregar

Antes de devolver la lista, el extractor aplica varias limpiezas:

| Situación | Acción |
|---|---|
| Producto `Visible` + `Obsoleto = true` | Se cambia a `Invisible` |
| Dos productos con el mismo `OriginId` | Se queda solo el primero, se loguea error |
| Dos variantes con el mismo `OriginId` en un producto | Se queda solo la primera, se loguea error |

### Las dos salidas independientes

La actividad tiene dos outputs, y cada workflow usa solo el que necesita:

```csharp
[Output] public required Output<Box<IProduct>>      ProductsOutput { get; init; }
[Output] public required Output<Box<IProductImage>> ProductsImagesOutput { get; init; }
```

El workflow de Productos ignora las imágenes. El workflow de Imágenes ignora los productos. Ambos llaman a SalesLayer una sola vez.

### Caché en debug

Tanto este extractor como otros usan [`FuncUtils.WithCachedRun(...)`](04c-extractors-metodos.md#2-funcutilswithcachedrun-la-cache-de-desarrollo). En entorno de desarrollo, si ya existe el resultado de una llamada guardado en disco (`tmp/debug/...`), no vuelve a llamar a la API y devuelve el fichero cacheado. Esto ahorra tiempo y evita consumir cuota de la API durante el desarrollo.

---

## Extractor 2 — Clientes del ERP

**Clase**: `CustomerExtract`
**Fichero**: `Extractors/CustomerExtract.cs`
**Origen**: API de Provalliance (vía `ProvallianceService`)
**Usado en**: Workflow de Clientes

### Qué hace

Llama al endpoint `/clients/client` de la API de Provalliance para obtener la lista completa de clientes y los entrega como `ICompany`. El servicio [`ProvallianceService.GetClients()`](04c-extractors-metodos.md#getclients) gestiona la paginación automáticamente.

### Paginación de la respuesta

La API de Provalliance pagina los clientes en páginas de 50. El servicio itera hasta que una página devuelve menos de 50 resultados:

```csharp
do {
    response = await PerformRequest(..., endpoint);
    companys.AddRange(response.ClientsList);
    endpoint = response.NextPageLink.Substring(_baseUrl.Length);
} while (response.ClientsList.Count == 50);
```

### Filtrado de leads

La configuración `ShopifyCredentials:LeadPrefix` (por defecto `"LEAD#"`) permite excluir del proceso a los registros que son leads comerciales y no clientes reales:

```csharp
clientes = clientes.Where(c =>
    !c.OriginId.Trim().StartsWith(leadPrefix, StringComparison.OrdinalIgnoreCase)
).ToList();
```

### Enriquecimiento de datos

Antes de entregar los clientes, el extractor hace dos enriquecimientos:

1. **`LocationOriginId`**: cada dirección del cliente recibe un identificador compuesto: `{CodCliente}#{CodDireccion}`. Esto es necesario porque el código de dirección solo es único dentro de un cliente, no de forma global.

2. **`Crn`**: el número de IVA del cliente se copia en cada una de sus direcciones, para que esté disponible a nivel de sucursal (location) durante la transformación.

### Validación mínima

Si la lista de clientes llega vacía, el extractor lanza una excepción que para el workflow completo. Esto evita que una respuesta vacía por un error de red se interprete como "no hay clientes" y archive todos los clientes de Shopify.

---

## Extractor 3 — Stock del ERP

**Clase**: `StockExtract`
**Fichero**: `Extractors/StockExtract.cs`
**Origen**: API de Provalliance (vía `ProvallianceService`)
**Usado en**: Workflow de Stock

### Qué hace

Es el extractor más sencillo del sistema. Llama al endpoint `/stock/shopify` y devuelve la lista de objetos `Stock` tal cual. No hay paginación, no hay filtros, no hay agrupaciones.

```csharp
var response = await provallianceService.GetStock();
Output.Set(context, response);
```

Cada objeto `Stock` contiene el identificador de la variante en el sistema origen y la cantidad disponible. La transformación posterior se encargará de cruzar ese identificador con el de Shopify.

---

## Extractor 4 — Pedidos de Shopify

**Clase**: `OrdersExtractor`
**Fichero**: `Comunes/UPG.Pataky.Shared/Loaders/Shopify/Orders/OrdersExtractor.cs`
**Origen**: Shopify (a través de `ShopifySDK`)
**Usado en**: Workflow de Pedidos

### Qué hace

Lee pedidos de Shopify aplicando el filtro configurado en `appsettings.json`:

```json
"FilterOrders": {
  "query": "tag_not:Sincronizado"
}
```

El SDK de Shopify recibe esa query directamente y devuelve solo los pedidos que la cumplen. En la práctica, esto significa todos los pedidos que **aún no han sido enviados al ERP**.

### Por qué vive en el proyecto compartido

A diferencia del resto de extractors (que viven en este repo porque son específicos de Provalliance), este extractor lee de Shopify — y la lógica de leer pedidos de Shopify es la misma para cualquier cliente de Upango. Por eso vive en el proyecto compartido `Loaders`.

---

## Extractor 5 — Imágenes del FTP

**Clase**: `LocalImagesExtractor`
**Fichero**: `Extractors/PicsLocalExtractor.cs`
**Origen**: Servidor FTP
**Usado en**: Workflow de Imágenes PIM

### Qué hace

Se conecta al servidor FTP configurado, lista todos los ficheros de las carpetas remotas configuradas y los convierte en objetos `NasFile`.

Para cada fichero de imagen aplica una convención de nombrado: `REFERENCIA-ORDEN.ext`. Por ejemplo:
- `GHD001-1.jpg` → referencia `GHD001`, orden `1`
- `SECHE-VITE-2.png` → referencia `SECHE-VITE`, orden `2`

### El CSV que genera

Además de listar los ficheros, genera un fichero `CSV_CargaImages.csv` con los nombres de todas las imágenes encontradas y lo sube al mismo FTP:

```csv
Imagen
GHD001-1.jpg
GHD001-2.jpg
SECHE-VITE-2.png
...
```

Este CSV es leído periódicamente por SalesLayer para actualizar las imágenes asociadas a cada referencia en el PIM.

### Filtro por prefijo

Si se configura `FileNameStartsWith` en `appsettings.json`, solo se procesan las imágenes cuyos nombres empiecen por alguno de esos prefijos. Útil para cuando el FTP contiene imágenes de varias marcas y solo se quieren procesar algunas.

---

## Extractor 6 — Traducciones

**Clase**: `TranslationsExtract`
**Fichero**: `Extractors/TranslationsExtract.cs`
**Origen**: Lista de productos ya extraídos (no llama a ninguna API)
**Estado**: Existe pero no está conectado a ningún workflow activo

### Qué hace

Recibe como input la lista de productos ya extraída por `ProductsWithImagesExtract` y filtra los que implementan la interfaz `ITranslatable`. Esos productos son los que tienen contenido que puede traducirse (nombre, descripción, etc.).

No es un extractor en el sentido estricto porque no llama a ningún sistema externo — simplemente filtra una lista que ya existe en memoria. Sirve como paso previo a un posible workflow de traducciones que aún no está implementado.

---

## Extractor 7 — Tarifas de precios

**Clase**: `ExtractTarifas`
**Fichero**: `Extractors/PriceListExtract.cs`
**Estado**: Stub — no implementado

### Qué hace (actualmente: nada)

Esta clase existe pero está vacía. Devuelve siempre una lista vacía de `IPriceList`. Los comentarios internos sugieren que debería leer tarifas del ERP, pero la implementación está pendiente o fue descartada.

```csharp
PriceLists.Set(context, new Box<IPriceList>(new List<IPriceList>()));
```

La gestión de tarifas de precio en el sistema actual se hace de otra manera: las tarifas (`PriceList`) se sincronizan mediante las actividades `SyncPriceLists` del workflow de Clientes, que las leen directamente de Shopify.

---

## Extractor 8 — Migración desde Shopify

**Clase**: `ShopifyExtract`
**Fichero**: `Extractors/Migration/ShopifyExtract.cs`
**Origen**: Shopify
**Estado**: Herramienta de migración puntual — desactivada (`ShouldRunAsync() => false`)

### Para qué existe

Este extractor no forma parte del flujo de sincronización habitual. Es una **herramienta de migración** que se usó en la puesta en marcha del proyecto para poblar la base de datos de transacciones a partir del estado inicial de Shopify.

### Qué hace

Descarga todos los productos y variantes que ya existían en Shopify y los registra en la BD de transacciones, leyendo el metafield `originId` de cada uno para saber a qué referencia del ERP corresponde.

Está permanentemente desactivado (`ShouldRunAsync() => false`) porque ya no es necesario: el sistema se mantiene sincronizado mediante los workflows normales. Se conserva en el código por si en algún momento se necesita repetir una migración inicial.

---

## Resumen: qué lee cada extractor y de dónde

| Extractor | Sistema origen | Autenticación | Paginación |
|---|---|---|---|
| `ProductsWithImagesExtract` | SalesLayer (PIM) | API Key por canal | No (descarga todo) |
| `CustomerExtract` | Provalliance API | OAuth2 Bearer | Sí (50 por página) |
| `StockExtract` | Provalliance API | OAuth2 Bearer | No |
| `OrdersExtractor` | Shopify | Access Token | No (filtra por tag) |
| `LocalImagesExtractor` | Servidor FTP | Usuario/contraseña | No (listado recursivo) |
| `TranslationsExtract` | Memoria (productos ya extraídos) | — | — |
| `ExtractTarifas` | — (no implementado) | — | — |
| `ShopifyExtract` | Shopify | Access Token | No (bulk) |

---

## Siguiente paso

Con los extractors claros, el siguiente documento explica la capa de Decisions: cómo se clasifican los datos extraídos en operaciones concretas (crear / actualizar / borrar) consultando la BD de transacciones.

→ [04d — Los Decisions](04d-decisions.md)

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [`04b-extractors-detalle.md`](04b-extractors-detalle.md) | Estructura campo a campo de cada objeto que produce cada extractor |
| [`04c-extractors-metodos.md`](04c-extractors-metodos.md) | Explicación paso a paso de cada método y función |
| [`04d-decisions.md`](04d-decisions.md) | La siguiente capa: clasificación de entidades para Shopify |
