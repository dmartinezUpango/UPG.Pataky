---
tags:
  - Marketplaces
  - Mapeo
  - AutoMapper
  - eWheel
  - ShoppingFeed
---

# Mapeo y transformación

Este documento reúne toda la lógica de **traducción de datos** entre los tres formatos del conector: los modelos de la API de ShoppingFeed (`SF*`), los modelos de dominio (`Order`, `Inventory`, `ProductPrice`) y los modelos del ERP (`EwheelOrder`). Casi todo vive en `AutoMapperProfileShoppingFeed` y en dos clases de configuración de mapeo.

---

## Índice

1. [El perfil AutoMapper](#el-perfil-automapper)
2. [Inventario y precios](#inventario-y-precios)
3. [Pedidos: `SFOrder → Order`](#pedidos-sforder-order)
4. [Pedidos: `Order → EwheelOrder`](#pedidos-order-ewheelorder)
5. [Mapeo de canales (channel → marketplace)](#mapeo-de-canales-channel-marketplace)
6. [Mapeo de países (marketplace + país → cliente)](#mapeo-de-paises-marketplace-pais-cliente)
7. [Transliteración cirílica](#transliteracion-cirilica)
8. [Código de nación de Sage](#codigo-de-nacion-de-sage)
9. [Documentos relacionados](#documentos-relacionados)

---

## El perfil AutoMapper

`AutoMapperProfileShoppingFeed` (registrado en `Program.cs`) define todos los mapeos. Se agrupan en tres regiones: **Inventory**, **Pricing** y **Order**.

---

## Inventario y precios

| Origen | Destino | Notas |
|---|---|---|
| `SFInventoryRequest` / `SFInventoryResponse` | `Inventory` | `Reference → ProductReference`, `Stock → StockTotal` |
| `ProductoConStock` | `Inventory` | `SKU → ProductReference`, `Stock → StockTotal` |
| `SFPriceRequest` / `SFPriceResponse` | `ProductPrice` | `Reference → ProductReference`, `Price → NetPrice`, `PriceType = NET` |
| `PrecioProducto` | `ProductPrice` | `SKU → ProductReference`, `Precio → NetPrice` |

Todos son `ReverseMap`, de modo que sirven en ambos sentidos (leer de SF y escribir en SF).

---

## Pedidos: `SFOrder → Order`

Es el mapeo más rico. Convierte el pedido crudo de ShoppingFeed en el modelo de dominio `Order`. Puntos destacables:

| Campo destino | Origen / lógica |
|---|---|
| `CardName` | Nombre de cliente (billing → shipping → email), vía `ShoppingFeedMappingHelper` |
| `LicTradNum` | DNI/NIF del cliente (campo `other` de la dirección) |
| `NumAtCard` | `SFOrder.Id` (ID interno de SF) |
| `U_CPR_IDChannel` | `SFOrder.ChannelId` |
| `U_CPR_RefMKTPlace` | `SFOrder.Reference` (referencia en el marketplace) |
| `U_CPR_ChannelCode` | `channel_code` de `AdditionalFields` (vía `ChannelCodeResolver`) |
| `CurrentStatus` | `GetOrderStatus`: traduce el estado textual de SF a `OrderStatusEnum` |
| `Addresses` | `GetAddressesFromOrder`: shipping + billing válidas |
| `DocumentLines` | `GetDocumentLinesFromOrder`: una línea por ítem (`Reference`, `Price`, `Quantity`) |
| `DocumentAdditionalExpenses` | Gastos de envío (con **parche Miravia**, ver abajo) |

### Traducción de estados (`GetOrderStatus`)

| Estado SF | `OrderStatusEnum` |
|---|---|
| `created`, `waiting_store_acceptance` | `CREATED` |
| `refused` | `REFUSED` |
| `waiting_shipment` | `READY_FOR_SHIPPING` |
| `shipped`, `partially_shipped` | `SHIPPED` |
| `cancelled` | `CANCELLED` |
| `refunded`, `partially_refunded` | `REFUNDED` |

### Parche Miravia (gastos de envío)

En `GetPaymentShippingAmountByChannel`, si el canal es Miravia (`channelId == 46619`) los gastos de envío se fuerzan a **0** a petición de negocio, para que no lleguen al ERP. El resto de canales pasan el importe real.

### Código de transportista (`GetCarrierCodeFromOrder`)

Traduce el nombre del carrier a un código numérico de Sage (según documentación de Seidor):

| Carrier | Código |
|---|---|
| Medios Clientes | 1 |
| Chrono | 2 |
| Palma Cargo | 3 |
| Redur | 4 |
| Medios Marlu | 5 |
| #Sin definir | 6 |
| DHL | 7 |
| Adelante Logística | 8 |

---

## Pedidos: `Order → EwheelOrder`

Mapeo base que prepara el pedido para el ERP. AutoMapper solo cubre los campos directos; el grueso de la lógica (cliente, dirección, moneda) lo añade el Worker en [`CreateSaleRequestFromOrder`](mp-wf-pedidos-sf-erp.md#la-transformacion-a-ewheelorder).

| Campo `EwheelOrder` | Origen |
|---|---|
| `OrderDate` | `DocDate` formateado `yyyy-MM-ddTHH:mm:ss` |
| `GrossAmount` / `TotalWeb` | `AmountTotal` (string, cultura invariante) |
| `CurrencyCode` | `Currency` |
| `PaymentConditionCode` | fijo `"16"` |
| `NumeroPedido` | `NumAtCard` |

También se mapean `Order → SFOrderShipRequest`, `SFOrderCancelRequest` y `SFOrderRefundRequest` para los cambios de estado de salida.

---

## Mapeo de canales (channel → marketplace)

`ChannelMappingConfig` lee la sección `ChannelMapping` y traduce el **`channelId` de ShoppingFeed** al **nombre de marketplace**:

```json
"ChannelMapping": {
  "36916": "Decathlon",
  "38996": "Saturn",
  "66":    "Amazon",
  "31376": "PcComponentes",
  "31796": "Worten",
  "44":    "Ebay",
  "54184": "Temu",
  "34210": "AliExpress"
}
```

```csharp
public string GetMarketplaceByChannelId(string channelId)
    => _channelToMarketplaceMap.TryGetValue(channelId, out var mkt) ? mkt : null;
```

---

## Mapeo de países (marketplace + país → cliente)

Para Amazon, Worten y eBay el cliente del ERP depende del **país** del pedido. `CountryMappingFactory` construye un `CountryMappingConfig` por marketplace, leyendo la sección `<Marketplace>CountryMapping`:

```csharp
public CountryMappingConfig ForMarketplace(string marketplace)
    => new(_config, $"{marketplace}CountryMapping");
```

```json
"AmazonCountryMapping": {
  "es": "9326", "nl": "9665", "se": "9666", "it": "9571",
  "pl": "9667", "de": "9668", "be": "9669", "gb": "9670",
  "fr": "9671", "ie": "9672"
},
"WortenCountryMapping": { "WRT_ES_ONLINE": "9777", "WRT_PT_ONLINE": "9779" },
"EbayCountryMapping":   { "fr": "10104", "it": "10106", "de": "10108", "hu": "10118" }
```

### Resolución completa del cliente

```text
channelId ──(ChannelMapping)──▶ marketplace
   │
   ├─ Decathlon/Saturn/PcComponentes/Temu/AliExpress ──▶ customerId fijo
   └─ Amazon/Worten/Ebay ──(<Mkt>CountryMapping[country])──▶ customerId por país
                                       │
                                       └─ sin mapeo → Ebay: 9950 (fallback)
```

---

## Transliteración cirílica

`CyrillicTransliterationHelper.TransliterateCustomerName` convierte nombres en alfabeto cirílico (ruso y ucraniano) a alfabeto latino antes de enviarlos al ERP, que no admite caracteres cirílicos. Maneja casos especiales contextuales (Є/Ї al inicio de palabra) y un mapa carácter-a-cadena para el resto.

Ejemplo: `Олександр` → `Oleksandr`.

---

## Código de nación de Sage

`MapCodigoNacionEnvios` (en el Worker [Pedidos SF → ERP](mp-wf-pedidos-sf-erp.md)) traduce el código de país ISO de la dirección de envío al **código de nación interno de Sage 200**, mediante un diccionario de ~250 países. Si el país viene vacío o no está mapeado, usa **108 (España)** por defecto.

```text
ES → 108    FR → 110    DE → 126    GB → 125
IT → 115    PT → 123    PL → 122    NL → 121   …
```

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [Pedidos SF → ERP](mp-wf-pedidos-sf-erp.md) | Dónde se aplican estos mapeos |
| [Modelos de datos](mp-modelos.md) | Estructura de `SFOrder`, `Order`, `EwheelOrder` |
| [Configuración](mp-configuracion.md) | Secciones `ChannelMapping` y `<Mkt>CountryMapping` |
