---
tags:
  - Marketplaces
  - Procesos
  - Pedidos
  - eWheel
  - ShoppingFeed
---

# Proceso — Pedidos (ERP → SF)

El proceso inverso al anterior: detecta en el ERP los pedidos que **ya se han enviado** (tienen albarán con agencia y tracking) y los marca como **enviados** (`SHIPPED`) en ShoppingFeed, propagando el número de seguimiento al marketplace.

---

## Índice

1. [Resumen](#resumen)
2. [Grafo del proceso](#grafo-del-proceso)
3. [Pasos](#pasos)
4. [La condición de "enviado"](#la-condicion-de-enviado)
5. [Variables del proceso](#variables-del-proceso)
6. [Configuración](#configuracion)
7. [Métodos](#metodos)
8. [Documentos relacionados](#documentos-relacionados)

---

## Resumen

| Campo | Valor |
|---|---|
| **Clase** | `WorkerOrdersERPToSF` |
| **Fichero** | `Workers/WorkerOrdersERPToSF.cs` |
| **Config key** | `WorkerOrdersERPToSF` |
| **Dirección** | ERP eWheel → ShoppingFeed |
| **Cron** | `5/5 * * * *` (cada 5 min, a partir del min 5) |
| **Activo en RELEASE** | ✅ |

---

## Grafo del proceso

=== ":material-chart-timeline-variant: Estático"

    ```mermaid
    flowchart LR
        DB[("MySQL\nseguimiento_orders")]
        ERP[("eWheel ERP\nVIS_TEES_CabeceraAlbaranClient")]
        SF[("ShoppingFeed")]

        GETDB["Pedidos en estados\nCREATED / IN_PROCESS /\nREADY_FOR_SHIPPING"]
        ALB["GetAlbaranByPedido\n¿existe albarán?"]
        BUILD["CreateOrderFromSaleState\n¿agencia + tracking? → SHIPPED"]
        UPD["UpdateOrders\nPOST /order/ship"]
        SAVE["Actualizar estado en BD"]

        DB -. "lee" .-> GETDB
        GETDB --> ALB
        ERP -. "albarán" .-> ALB
        ALB --> BUILD --> UPD
        UPD -. "ship" .-> SF
        UPD --> SAVE --> DB
    ```

---

## Pasos

| # | Acción | Detalle |
|---|---|---|
| 1 | Leer pedidos de BD | `seguimiento_orders` filtrado por `DatabaseManagementSettings:OrderStatusFilter` |
| 2 | Buscar albarán en ERP | `GetAlbaranByPedido(SFReference)` sobre `VIS_TEES_CabeceraAlbaranClient` |
| 3 | Evaluar envío | `CreateOrderFromSaleState`: si el albarán tiene agencia y tracking → `Order` en estado `SHIPPED` |
| 4 | Actualizar SF | `IFeedService.UpdateOrders(updatedOrders)` (ship/cancel/refund) |
| 5 | Sincronizar BD | Por cada resultado correcto, actualiza `Status` y `LastUpdate` en `seguimiento_orders` |
| 6 | Escribir registro | Marca temporal del proceso |

El filtro de estados de partida es configurable:

```json
"DatabaseManagementSettings": {
  "OrderStatusFilter": "CREATED,IN_PROCESS,READY_FOR_SHIPPING"
}
```

Es decir: solo se revisan pedidos que aún **no** están marcados como enviados/cancelados/devueltos.

---

## La condición de "enviado"

Un pedido se promueve a `SHIPPED` **solo si** su albarán en el ERP tiene **ambos** datos de expedición:

```csharp
if (string.IsNullOrWhiteSpace(albaran.ServicioAgencia)
 || string.IsNullOrWhiteSpace(albaran.IdTracking))
{
    // No se marca como 'Enviado'
    return null;
}

var order = new Order {
    NumAtCard = dbentity.IdERP,
    TrackingNumber = albaran.IdTracking.Trim(),
    Carrier = albaran.ServicioAgencia.Trim(),
    ReturnInfo = new ReturnInfo { Carrier = ..., TrackingNumber = ... }
};
order.SetStatus(OrderStatusEnum.SHIPPED);
```

Si falta la agencia o el tracking, el pedido se deja como está y se reintentará en la siguiente ejecución (cuando el ERP haya completado la expedición).

> El número de seguimiento (`IdTracking`) y la agencia (`ServicioAgencia`) se propagan a ShoppingFeed, que a su vez los comunica al marketplace para que el comprador pueda seguir su pedido.

---

## Variables del proceso

| Variable | Tipo | Descripción |
|---|---|---|
| `dBOrderEntities` | `List<DBewheelOrderEntity>` | Pedidos en seguimiento pendientes de envío |
| `albaran` | `VisTeesCabeceraAlbaranClient` | Cabecera de albarán del ERP |
| `updatedOrders` | `List<Order>` | Pedidos a marcar como enviados en SF |
| `updateResponse` | `APIResponse<List<UpdateResult>>` | Resultado por pedido (éxito/error) |

---

## Configuración

```json title="appsettings.json"
"WorkerOrdersERPToSF": {
  "Name": "WorkerOrdersERPToSF",
  "Description": "Actualización de los datos de envío en ShoppingFeed, con datos obtenidos del ERP.",
  "Cron": "5/5 * * * *",
  "EnableErrorRecovery": false
},
"DatabaseManagementSettings": {
  "OrderStatusFilter": "CREATED,IN_PROCESS,READY_FOR_SHIPPING"
}
```

---

## Métodos

| Método | Propósito |
|---|---|
| `DoWork` / `ProcessOrdersFromErpToShoppingFeedAsync` | Orquestación, conexión a BD y registro de control |
| `GetDBOrdersByConfigStatusAsync` | Lee `seguimiento_orders` por los estados configurados |
| `CreateOrderFromSaleState` | Comprueba el albarán y construye el `Order` `SHIPPED` |

El método `UpdateOrders` (en `ShoppingFeedService`) reparte internamente por estado y usa el [patrón de tickets de batch](mp-shoppingfeed.md#el-patron-de-tickets-de-batch) para confirmar el resultado real de cada envío.

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [eWheel](mp-ewheel.md) | `GetAlbaranByPedido` y la vista `VIS_TEES_CabeceraAlbaranClient` |
| [ShoppingFeed](mp-shoppingfeed.md) | `UpdateOrders`, `UpdateOrdersAsShipped` y tickets de batch |
| [Pedidos SF → ERP](mp-wf-pedidos-sf-erp.md) | El proceso que crea estos pedidos |
| [Modelos de datos](mp-modelos.md) | `DBewheelOrderEntity`, `Order`, `UpdateResult` |
