---
tags:
  - Marketplaces
  - eWheel
  - ERP
  - Servicios
---

# eWheel — el servicio del ERP (TEES)

`EwheelService` (`UPG.Marketplaces.Services/Ewheel/EwheelService.cs`) es la capa que habla con el ERP **eWheel**, cuyo sistema interno se llama **TEES** y está construido sobre **Sage 200**. El servicio combina **dos vías de acceso** al ERP:

- **API REST** del ERP (`<EWHEEL_API_BASE_URL>`) — para **autenticarse** y **crear pedidos**.
- **Acceso directo a la BD SQL Server** de Sage 200 (`EwheelDbContext`) — para **leer** stock, tarifas de precio y albaranes mediante vistas `VIS_TEES_*`.

Implementa la interfaz `IEwheelService` y hereda de `RESTServiceBase` (la misma base que ShoppingFeed para el transporte HTTP, rate-limit y paginación).

---

## Índice

1. [Resumen](#resumen)
2. [Autenticación](#autenticacion)
3. [Operaciones REST](#operaciones-rest)
4. [Operaciones sobre la BD de Sage](#operaciones-sobre-la-bd-de-sage)
5. [Creación de pedidos: el patrón plantilla](#creacion-de-pedidos-el-patron-plantilla)
6. [Rate-limit](#rate-limit)
7. [Métodos de `IEwheelService`](#metodos-de-iewheelservice)
8. [Documentos relacionados](#documentos-relacionados)

---

## Resumen

| Campo | Valor |
|---|---|
| **Clase** | `EwheelService` |
| **Interfaz** | `IEwheelService : IRESTService` |
| **Fichero** | `Ewheel/EwheelService.cs` |
| **Config** | `EwheelServiceConfig` (sección `EwheelServiceConfig`) |
| **API REST** | `<EWHEEL_API_BASE_URL>/api/...` |
| **BD directa** | `EwheelDbContext` (SQL Server `DefaultConnection`) |
| **Registro DI** | `AddScoped<IEwheelService, EwheelService>` |

---

## Autenticación

La API de TEES usa autenticación por **token** con usuario y contraseña. El flujo (`FetchToken` / `InitializeAuthentication`):

```text
1. GET <EWHEEL_API_BASE_URL>/api/autentificar?name=<user>&password=<pwd>
2. Respuesta JSON: { "resultado": "ok", "token": "<token>" }
3. Si resultado == "ok":
     · Se guarda el token (SetAccessToken) como Bearer
     · Se fija expiración local: ahora + 1 hora (_tokenExpiration)
4. Si no → excepción "Autenticación fallida"
```

Antes de cada operación REST sensible (`CreateOrder`, `GetOrderTemplate`), el servicio comprueba si el token ha expirado (`DateTime.UtcNow >= _tokenExpiration`) y, si es así, **se reautentica automáticamente**.

Las credenciales viven en `EwheelServiceConfig`:

```json title="appsettings.json — EwheelServiceConfig"
"EwheelServiceConfig": {
  "AuthUrl": "<EWHEEL_AUTH_URL>",
  "CreateOrderUrl": "<EWHEEL_CREATE_ORDER_URL>",
  "User": "<EWHEEL_API_USER>",
  "Password": "<EWHEEL_API_PASSWORD>",
  "SalesLayerApiKey": "<SALESLAYER_API_KEY>",
  "SalesLayerConnectorId": "<SALESLAYER_CONNECTOR_ID>",
  "SalesLayerBaseUrl": "<SALESLAYER_BASE_URL>"
}
```

---

## Operaciones REST

| Método | Verbo / Endpoint | Devuelve |
|---|---|---|
| `InitializeAuthentication()` | `GET /api/autentificar` | `bool` (token obtenido) |
| `GetOrderTemplate()` *(privado)* | `GET …/CabeceraPedidoCliente/create` | Plantilla JSON del pedido |
| `CreateOrder(EwheelOrder)` | `POST …/CabeceraPedidoCliente/create` | `EwheelOrderResponse` |
| `GetProductos()` | `GET` a SalesLayer | `List<SalesLayerProduct>` |

> `GetProductos()` no llama al ERP sino al **PIM SalesLayer** (`SalesLayerBaseUrl` + `ConnectorId` + `ApiKey`), devolviendo el catálogo como diccionario de `SalesLayerProduct`. No lo consume ningún Worker activo de la rama eWheel; se conserva como utilidad.

---

## Operaciones sobre la BD de Sage

Estas operaciones **no usan la API REST**: consultan directamente la BD de Sage 200 mediante `EwheelDbContext` (todas con `AsNoTracking`).

| Método | Tabla / Vista | Lógica |
|---|---|---|
| `GetStockByCodigoArticulo(sku)` | `VIS_TEES_StockDisponible` | Devuelve `StockDisponible` de la referencia (0 si no existe) |
| `GetPrecioByCodigoArticulo(sku, empresa=3)` | `TarifaPrecio` | Precio vigente (fecha entre inicio/final), el de `FechaInicio` más reciente |
| `GetPreciosProducto(empresa=3)` | `TarifaPrecio` | Todas las tarifas vigentes, una por artículo (la más reciente) |
| `GetAlbaranByPedido(refMarketplace)` | `VIS_TEES_CabeceraAlbaranClient` | Albarán cuyo `refmarketplace` coincide con el pedido |
| `GetProductosConStock(...)` | SalesLayer + stock | Cruza productos de SalesLayer con su stock del ERP |

La empresa por defecto es **3** (`CompanyCode`), el código de empresa de eWheel en Sage.

---

## Creación de pedidos: el patrón plantilla

`CreateOrder` no construye el JSON del pedido desde cero: **pide primero una plantilla** al ERP y la rellena. Esto garantiza que el payload tenga exactamente la estructura (`$resources`, `$schema`, líneas) que TEES espera.

```text
1. (token expirado?) → reautenticar
2. GET CreateOrderUrl → plantilla JSON  (GetOrderTemplate)
3. DeepClone de la plantilla
4. Localiza $resources y la plantilla de la primera línea (LineasPedidoCliente[0])
5. Vacía el array de líneas
6. Rellena la CABECERA campo a campo (Set):
     CodigoEmpresa, CodigoCliente, ImporteBruto, TotalWeb, CodigoDivisa,
     Domicilio, CodigoPostal, Municipio, Provincia, refmarketplace,
     MarketPlace, CodigoNacionEnvios, EmailMultiCliente, …
7. Por cada línea del pedido → clona la plantilla de línea y rellena:
     CodigoArticulo, UnidadesPedidas, Precio, ImporteDescuento,
     LineasPosicion (GUID), Orden (índice), IvaIncluido
8. Set NumeroLineas = nº de líneas
9. POST $resources serializado → CreateOrderUrl
10. Deserializa la respuesta a EwheelOrderResponse
```

La función local `Set(obj, name, value)` aplica conversión de tipos defensiva: respeta `string`/`int`/`decimal`, intenta parsear numéricos y, en último caso, serializa el objeto. **Ignora los valores `null`** para no sobrescribir los campos de la plantilla.

> El mapeo de un `Order` de ShoppingFeed a un `EwheelOrder` (qué cliente, qué moneda, qué dirección) **no ocurre aquí**, sino en el Worker [Pedidos SF → ERP](mp-wf-pedidos-sf-erp.md) y en el [AutoMapper](mp-mapeo.md). `EwheelService.CreateOrder` solo traduce un `EwheelOrder` ya construido al JSON de TEES.

---

## Rate-limit

`EwheelService` sobreescribe los hooks de `RESTServiceBase`:

- `HandleRateLimitBeforeRequestAsync` → no hace nada (sin pre-throttling).
- `HandleRateLimitOnResponseAsync` → si la respuesta es `429 TooManyRequests` y trae la cabecera `X-Ratelimit-Wait`, espera ese número de segundos y reintenta.

---

## Métodos de `IEwheelService`

```csharp
public interface IEwheelService : IRESTService
{
    Task<bool> InitializeAuthentication();
    Task<decimal> GetStockByCodigoArticulo(string codigoArticulo);
    Task<decimal> GetPrecioByCodigoArticulo(string codigoArticulo, short empresa = 3);
    Task<EwheelOrderResponse> CreateOrder(EwheelOrder ewheelOrder);
    Task<List<SalesLayerProduct>> GetProductos();
    Task<List<ProductoConStock>> GetProductosConStock(IEwheelService ewheelService);
    Task<List<PrecioProducto>> GetPreciosProducto(short empresa = 3);
    Task<VisTeesCabeceraAlbaranClient?> GetAlbaranByPedido(string numeroPedido);
}
```

| Usado por | Métodos que consume |
|---|---|
| [Worker Stock](mp-wf-stock.md) | `InitializeAuthentication`, `GetStockByCodigoArticulo` |
| [Worker Pedidos SF → ERP](mp-wf-pedidos-sf-erp.md) | `CreateOrder` |
| [Worker Pedidos ERP → SF](mp-wf-pedidos-erp-sf.md) | `GetAlbaranByPedido` |
| [Worker Precios](mp-wf-precios.md) | `GetPreciosProducto` |

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [ShoppingFeed](mp-shoppingfeed.md) | La otra "pata" de cada proceso |
| [Modelos de datos](mp-modelos.md) | `EwheelOrder`, `TarifaPrecio`, vistas `VIS_TEES_*` |
| [Mapeo y transformación](mp-mapeo.md) | Cómo se construye un `EwheelOrder` desde un pedido SF |
| [Configuración](mp-configuracion.md) | `EwheelServiceConfig` y cadenas de conexión |
