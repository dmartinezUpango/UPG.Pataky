---
tags:
  - Marketplaces
  - Modelos
  - eWheel
  - ShoppingFeed
---

# Modelos de datos

Los modelos del conector se reparten entre tres "mundos": el del **ERP** (`Ewheel.*`), el de **dominio** (`CoreEntity.*`) y el de la **API de ShoppingFeed** (`SF*`). El mapeo entre ellos está en [Mapeo y transformación](mp-mapeo.md).

---

## Índice

1. [Modelos de dominio](#modelos-de-dominio)
2. [Modelos del ERP eWheel](#modelos-del-erp-ewheel)
3. [Vistas de Sage 200](#vistas-de-sage-200)
4. [Modelos de la API ShoppingFeed](#modelos-de-la-api-shoppingfeed)
5. [Bases de datos](#bases-de-datos)
6. [Documentos relacionados](#documentos-relacionados)

---

## Modelos de dominio

`UPG.Marketplaces.Models.CoreEntity` — el formato común sobre el que trabajan los procesos.

| Modelo | Campos clave | Uso |
|---|---|---|
| `Inventory` | `ProductReference`, `StockTotal`, `StockComprometido`, `StockDisponible` *(calc.)* | Stock |
| `ProductPrice` | `ProductReference`, `NetPrice`, `PriceType` | Precios |
| `Order` | `NumAtCard`, `U_CPR_IDChannel`, `U_CPR_RefMKTPlace`, `CurrentStatus`, `DocumentLines`, `Addresses`, `Carrier`, `TrackingNumber` | Pedidos |
| `UpdateResult` | `Id`, `Status`, `IsSuccessful`, `ErrorMessage` | Resultado de actualizar un pedido en SF |

```csharp title="Inventory"
public class Inventory
{
    public string ProductReference { get; set; }
    public double StockTotal { get; set; }
    public double StockComprometido { get; set; }
    public double StockDisponible => StockTotal - StockComprometido;
}
```

---

## Modelos del ERP eWheel

`UPG.Marketplaces.Models.Ewheel`.

### `EwheelOrder` / `EwheelOrderLine`

El pedido en el formato exacto que espera la API de TEES. Cada propiedad lleva su `[JsonProperty]` con el nombre que TEES reconoce (en español de Sage):

| Propiedad C# | JSON (Sage) | Significado |
|---|---|---|
| `CompanyCode` | `CodigoEmpresa` | Empresa (3 = eWheel) |
| `CustomerCode` | `CodigoCliente` | Cliente del ERP |
| `GrossAmount` | `ImporteBruto` | Importe bruto |
| `TotalWeb` | `TotalWeb` | Total del pedido web |
| `CurrencyCode` | `CodigoDivisa` | Divisa |
| `RefMarketplace` | `refmarketplace` | Referencia del marketplace |
| `Marketplace` | `MarketPlace` | Nombre del marketplace |
| `CodigoNacionEnvios` | `CodigoNacionEnvios` | Código de nación de Sage |
| `Lines` | `LineasPedidoCliente` | Líneas del pedido |

`EwheelOrderLine`: `ProductCode` (`CodigoArticulo`), `Quantity` (`UnidadesPedidas`), `UnitPrice` (`Precio`), `DiscountAmount`, `IvaIncluido`, `LinePosition` (`LineasPosicion`, un GUID).

`EwheelOrderResponse`: respuesta de TEES con `$queryName`, `$prefix`, `$schema` y `$resources` (lista de recursos creados).

### `TarifaPrecio` / `PrecioProducto`

`TarifaPrecio` mapea la tabla `TarifaPrecio` de Sage (tabla de tramos de precio por artículo/empresa/tarifa con vigencia `FechaInicio`–`FechaFinal` y 10 tramos `Precio1..Precio10`). `PrecioProducto` es el modelo simplificado que usan los procesos: `{ SKU, Precio }`.

### `SalesLayerProduct` / `ProductoConStock`

`SalesLayerProduct`: producto del PIM SalesLayer (SKU, EAN, dimensiones, PVP…). `ProductoConStock`: `{ SKU, Stock }`, el par que produce el [proceso de stock](mp-wf-stock.md).

---

## Vistas de Sage 200

Modelos sin clave primaria (`HasNoKey` / `ToView`) que mapean **vistas** de SQL Server, leídas por `EwheelDbContext`:

| Modelo | Vista | Contenido |
|---|---|---|
| `VisTeesStockDisponible` | `VIS_TEES_StockDisponible` | `CodigoArticulo`, `Stock`, `StockSeguridad`, `PendienteServir`, `StockDisponible` |
| `VisTeesCabeceraAlbaranClient` | `VIS_TEES_CabeceraAlbaranClient` | Cabecera de albarán: `IdTracking`, `ServicioAgencia`, `Refmarketplace`, `NumeroAlbaran`, `CodigoCliente`… |

`EstadoPedido` / `enum Estado` (`EnPreparacion`, `Preparado`, `Enviado`) modelan el estado interno del pedido en el ERP.

---

## Modelos de la API ShoppingFeed

`UPG.Marketplaces.Services.ShoppingFeed.Models` — reflejan el JSON de la API.

| Modelo | Contenido |
|---|---|
| `SFOrder` | Pedido: `Id`, `ChannelId`, `Reference`, `Status`, `Payment`, `Shipment`, `Items`, `ShippingAddress`, `BillingAddress`, `AdditionalFields` |
| `SFOrderPayment` | `ShippingAmount`, `ProductAmount`, `TotalAmount`, `Currency`, `Method` |
| `SFOrderShipment` | `Carrier`, `TrackingNumber`, `TrackingLink`, `ReturnInfo` |
| `SFOrderItem` | `Reference`, `Quantity`, `Price`, `Commission`, `TaxAmount`, `AdditionalFields` |
| `SFAddress` | `FirstName`, `LastName`, `Company`, `Street`, `City`, `Country`, `Province`, `PostalCode`, `Other` (DNI), `Email`, `Phone` |
| `SFInventoryRequest/Response`, `SFPriceRequest/Response` | Inventario y precios |
| `SFViewTicketResponse<T>`, `SFOrderTicketResponse` | Tickets del [patrón de batch](mp-shoppingfeed.md#el-patron-de-tickets-de-batch) |

> Nota de la API: `SFOrder.Id` es `long` (no `int`) porque los IDs de pedido de ShoppingFeed superan el rango de `Int32`.

---

## Bases de datos

### `EwheelDbContext` (SQL Server — Sage 200)

Solo **lectura**. Expone: `TarifaPrecios`, `VisTeesStockDisponibles`, `VisTeesCabeceraAlbaranClients`. Conexión: `DefaultConnection`.

### `ApplicationEwheelDbContext` (MySQL — seguimiento)

Lectura/escritura. Una sola tabla, `seguimiento_orders` (entidad `DBewheelOrderEntity`):

| Columna | Tipo | Significado |
|---|---|---|
| `Id` | int (PK) | Identidad |
| `IdERP` | string | Nº de documento del pedido en el ERP |
| `SFReference` | string | Referencia del pedido en ShoppingFeed |
| `Status` | enum→string | `CREATED`, `IN_PROCESS`, `READY_FOR_SHIPPING`, `SHIPPED`, `CANCELLED`, `REFUNDED`… |
| `LastUpdate` | datetime | Última modificación |

El enum `Status` se persiste como **string** (conversión configurada en `OnModelCreating`). Esta tabla es el "puente" de estado entre los dos procesos de pedidos. Se migra automáticamente al arrancar (ver [Arquitectura](mp-arquitectura.md#arranque-del-servicio)).

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [Mapeo y transformación](mp-mapeo.md) | Cómo se convierten entre sí estos modelos |
| [eWheel](mp-ewheel.md) | Servicio que lee las vistas y la tabla `TarifaPrecio` |
| [ShoppingFeed](mp-shoppingfeed.md) | Servicio que produce/consume los modelos `SF*` |
| [Configuración](mp-configuracion.md) | Cadenas de conexión a ambas BD |
