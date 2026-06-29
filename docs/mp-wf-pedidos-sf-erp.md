---
tags:
  - Marketplaces
  - Procesos
  - Pedidos
  - eWheel
  - ShoppingFeed
---

# Proceso — Pedidos (SF → ERP)

Descarga de ShoppingFeed los pedidos pendientes de los marketplaces, los **transforma** al formato del ERP eWheel (cliente, moneda, dirección, nación) y los **crea** en TEES. Es el proceso más complejo del conector.

---

## Índice

1. [Resumen](#resumen)
2. [Grafo del proceso](#grafo-del-proceso)
3. [Pasos](#pasos)
4. [La transformación a `EwheelOrder`](#la-transformacion-a-ewheelorder)
5. [Variables del proceso](#variables-del-proceso)
6. [Configuración](#configuracion)
7. [Métodos](#metodos)
8. [Documentos relacionados](#documentos-relacionados)

---

## Resumen

| Campo | Valor |
|---|---|
| **Clase** | `WorkerOrdersSFToERP` |
| **Fichero** | `Workers/WorkerOrdersSFToERP.cs` |
| **Config key** | `WorkerOrdersSFToERP` |
| **Dirección** | ShoppingFeed → ERP eWheel |
| **Cron** | `10/5 * * * *` (cada 5 min, a partir del min 10) |
| **Activo en RELEASE** | ✅ |
| **Operación** | `SyncOperation.CreateOrder` |

---

## Grafo del proceso

=== ":material-chart-timeline-variant: Estático"

    ```mermaid
    flowchart LR
        SF[("ShoppingFeed\nPedidos")]
        ERP[("eWheel ERP\nTEES")]
        DB[("MySQL\nseguimiento_orders")]

        GETLAST["Registro de control\nLastSync"]
        GET["GetOrders(since=LastSync)\nunacknowledged + waiting_shipment"]
        MAP["CreateSaleRequestFromOrder\nOrder → EwheelOrder"]
        CREATE["EwheelService.CreateOrder"]
        ACK["AcknowledgeOrder(docNum)"]
        SAVE["SaveOrderToDatabase"]

        GETLAST --> GET
        SF -. "pedidos" .-> GET
        GET --> MAP --> CREATE
        CREATE -. "POST pedido" .-> ERP
        CREATE --> ACK
        ACK -. "acknowledge" .-> SF
        ACK --> SAVE --> DB
    ```

---

## Pasos

| # | Acción | Detalle |
|---|---|---|
| 1 | Recuperar `LastSync` | Del registro de control (`IRegistryManager.GetLastEntry`). Si no hay, 5 años atrás |
| 2 | Pedir pedidos a SF | `GetOrders({since: LastSync})` — combinado con `unacknowledged`, `waiting_shipment`, `isTest=false` de configuración |
| 3 | Por cada pedido | `CreateSaleRequestFromOrder` → `EwheelOrder` |
| 4 | Crear en ERP | `EwheelService.CreateOrder(sale)` |
| 5 | Confirmar a SF | `AcknowledgeOrder(SFOrderId, docNum)` con el nº de documento del ERP |
| 6 | Guardar seguimiento | `SaveOrderToDatabase` en `seguimiento_orders` (estado inicial) |
| 7 | Escribir registro | `WriteRegister` con la marca temporal del proceso |

### Gestión de errores por pedido

- Si **no se puede construir** el `EwheelOrder` → se omite el pedido (warning).
- Si el ERP **no devuelve recursos** → se hace acknowledge con estado `error` y mensaje "No resources returned by ERP".
- Si **lanza excepción** → acknowledge con el mensaje de error; el pedido no se guarda en BD.
- Solo si el acknowledge es correcto se persiste en `seguimiento_orders`.

---

## La transformación a `EwheelOrder`

`CreateSaleRequestFromOrder` es el corazón del proceso. Resuelve **qué cliente del ERP** corresponde al marketplace de origen y normaliza importes, direcciones y moneda.

### 1 · Resolución del cliente (channel → marketplace → customerId)

```text
1. channelId del pedido → nombre de marketplace (ChannelMappingConfig)
2. Según el marketplace, se asigna un CustomerCode del ERP:
     · Decathlon     → 7668
     · Saturn        → 9832
     · PcComponentes → 9673
     · Temu          → 10114
     · AliExpress    → 10116
     · Amazon/Worten/Ebay → según país (CountryMappingFactory)
```

Para Amazon, Worten y eBay el cliente depende del **país** del pedido (`U_CPR_ChannelCode`), resuelto con `CountryMappingFactory.ForMarketplace(...)`. Si no hay mapeo, eBay cae a un cliente por defecto (`9950`). Ver [Mapeo y transformación](mp-mapeo.md).

### 2 · Cabecera fija

```csharp
saleRequest.CompanyCode = 3;                 // empresa eWheel en Sage
saleRequest.OrderYear   = DateTime.Now.Year; // ejercicio
saleRequest.IvaIncluido = -1;                // IVA incluido (verdadero en Sage)
saleRequest.Marketplace = marketplace;
saleRequest.RefMarketplace = order.U_CPR_RefMKTPlace;
```

### 3 · Dirección de envío

De la dirección `SHIPPING` se extraen calle, CP, municipio, provincia, email y teléfono. Se aplican **límites de longitud de Sage**:

- Calle > 39 caracteres → se parte en `Domicilio` (39) + `Domicilio2`.
- Municipio se trunca a 25 caracteres.
- El **nombre del cliente** se transcribe con `CyrillicTransliterationHelper` (pedidos con nombres en cirílico ruso/ucraniano → alfabeto latino).
- El país se traduce a **código de nación de Sage** con `MapCodigoNacionEnvios` (tabla de ~250 países; por defecto `108` = España).

### 4 · Líneas y gastos de envío

- Cada `DocumentLine` del pedido → una `EwheelOrderLine` (código, cantidad, precio, descuento).
- Si hay gastos de envío (`ShippingAmount > 0`) → se añade una **línea especial** con el artículo `0000000110` "Gastos de Envío".

### 5 · Conversión de moneda a EUR

Si la moneda del pedido no es euros, se aplica un tipo de cambio **fijo** y se convierten cabecera y líneas:

| Moneda | Tipo a EUR |
|---|---|
| GBP | 1.1183 |
| SEK | 0.087 |
| DKK | 0.134 |

> Los tipos de cambio están **hardcodeados** en el Worker. Si se opera en más divisas o cambian las cotizaciones, hay que actualizarlos en `CreateSaleRequestFromOrder`.

---

## Variables del proceso

| Variable | Tipo | Descripción |
|---|---|---|
| `LastSync` | `DateTime` | Fecha de la última sincronización correcta |
| `sfOrders` | `List<Order>` | Pedidos descargados de ShoppingFeed |
| `sale` | `EwheelOrder` | Pedido transformado al formato del ERP |
| `saleResult` | `EwheelOrderResponse` | Respuesta del ERP a la creación |
| `dbOrder` | `DBewheelOrderEntity` | Registro de seguimiento del pedido |

---

## Configuración

```json title="appsettings.json"
"WorkerOrdersSFToERP": {
  "Name": "WorkerOrdersSFToERP",
  "Description": "Crear pedidos en ERP con los pedidos en estado 'Waiting Shipment' de ShoppingFeed.",
  "Cron": "10/5 * * * *",
  "EnableErrorRecovery": false
},
"ShoppingFeedServiceSettings": {
  "GetOrderParameters": {
    "acknowledgment": "unacknowledged",
    "isTest": "false",
    "status": "waiting_shipment"
  }
}
```

El mapeo de canales y países (`ChannelMapping`, `AmazonCountryMapping`, `WortenCountryMapping`, `EbayCountryMapping`) está en [Configuración](mp-configuracion.md).

---

## Métodos

| Método | Propósito |
|---|---|
| `DoWork` / `ProcessStoreOrdersAsync` | Orquestación, registro de control y manejo del ámbito DI |
| `RetrieveOrdersFromShoppingFeed` | Llama a `GetOrders` con `since=LastSync` |
| `ProcessOrders` | Bucle por pedido: crear, acknowledge, guardar |
| `CreateSaleRequestFromOrder` | La transformación `Order → EwheelOrder` descrita arriba |
| `SaveOrderToDatabase` | Inserta el pedido en `seguimiento_orders` |
| `MapOrderStatus` | Estado SF (string) → enum `DBewheelOrderEntityStatus` |
| `MapCodigoNacionEnvios` | País ISO → código de nación de Sage |

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [Mapeo y transformación](mp-mapeo.md) | `ChannelMapping`, países y AutoMapper `Order → EwheelOrder` |
| [eWheel](mp-ewheel.md) | `CreateOrder` y el patrón plantilla |
| [ShoppingFeed](mp-shoppingfeed.md) | `GetOrders`, `AcknowledgeOrder` y back-margin days |
| [Pedidos ERP → SF](mp-wf-pedidos-erp-sf.md) | El proceso inverso (envíos) |
| [Modelos de datos](mp-modelos.md) | `EwheelOrder`, `DBewheelOrderEntity`, `Order` |
