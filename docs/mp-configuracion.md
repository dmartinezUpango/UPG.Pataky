---
tags:
  - Marketplaces
  - Configuración
---

# Configuración

Toda la configuración del conector vive en `appsettings.json` y sus variantes por entorno `appsettings.dev.json` / `appsettings.prod.json`. La variable `DOTNET_ENVIRONMENT` decide cuál se superpone. Este documento describe cada bloque.

---

## Índice

1. [Cadenas de conexión](#cadenas-de-conexion)
2. [eWheel (ERP)](#ewheel-erp)
3. [ShoppingFeed](#shoppingfeed)
4. [Crons de los Workers](#crons-de-los-workers)
5. [Mapeo de canales y países](#mapeo-de-canales-y-paises)
6. [Filtro de estados de BD](#filtro-de-estados-de-bd)
7. [Registro de control de procesos](#registro-de-control-de-procesos)
8. [Diferencias dev / prod](#diferencias-dev-prod)
9. [Documentos relacionados](#documentos-relacionados)

---

## Cadenas de conexión

```json
"ConnectionStrings": {
  "DefaultConnection":     "Server=...;Database=Sage200;...",        // SQL Server (Sage 200)
  "ShoppingfeedConnection":"server=...;database=ewheeldb;..."        // MySQL (seguimiento)
}
```

| Clave | Motor | Usada por |
|---|---|---|
| `DefaultConnection` | SQL Server | `EwheelDbContext` (stock, tarifas, albaranes) |
| `ShoppingfeedConnection` | MySQL | `ApplicationEwheelDbContext` (`seguimiento_orders`) |

---

## eWheel (ERP)

```json
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

| Clave | Función |
|---|---|
| `AuthUrl` | Endpoint de autenticación (devuelve token) |
| `CreateOrderUrl` | Endpoint de plantilla y creación de pedidos |
| `User` / `Password` | Credenciales del API de TEES |
| `SalesLayer*` | Acceso al PIM SalesLayer (catálogo de productos) |

---

## ShoppingFeed

```json
"ShoppingFeedServiceSettings": {
  "User": "<SHOPPINGFEED_USER>",
  "Password": "<SHOPPINGFEED_PASSWORD>",
  "Token": "<SHOPPINGFEED_TOKEN>",
  "BaseURL": "<SHOPPINGFEED_BASE_URL>",
  "StoreId": "<SHOPPINGFEED_STORE_ID>",
  "GetOrderParameters": {
    "acknowledgment": "unacknowledged",
    "isTest": "false",
    "status": "waiting_shipment"
  },
  "EnableBackMarginDays": true,
  "GetOrderBackMarginDays": 7
}
```

| Clave | Función |
|---|---|
| `Token` | Autenticación preferida (si está, ignora User/Password) |
| `StoreId` | Identificador de la tienda/catálogo en SF |
| `GetOrderParameters` | Filtro por defecto al pedir pedidos (prevalece sobre el código) |
| `EnableBackMarginDays` / `GetOrderBackMarginDays` | Resta N días al `since` para no perder pedidos (recomendación de SF) |

---

## Crons de los Workers

Cada Worker lee su sección homónima. Formato cron estándar de 5 campos (`min hora día mes díaSemana`).

| Sección | Cron | Frecuencia | Activo |
|---|---|---|---|
| `WorkerStockSync` | `15/15 * * * *` | cada 15 min | ✅ |
| `WorkerOrdersSFToERP` | `10/5 * * * *` | cada 5 min (desde min 10) | ✅ |
| `WorkerOrdersERPToSF` | `5/5 * * * *` | cada 5 min (desde min 5) | ✅ |
| `WorkerPricesSync` | `0 10,13,16,22 * * *` | 4 veces/día | ❌ comentado |

Campos comunes de cada sección: `Name`, `Description`, `NumLimits` (límite de logs), `EnableErrorRecovery`.

> La sección `WorkerOrdersSync` que aparece en `appsettings.json` es **legado**: ningún Worker la usa (los Workers leen `WorkerOrdersSFToERP` / `WorkerOrdersERPToSF`).

---

## Mapeo de canales y países

```json
"ChannelMapping": {
  "36916": "Decathlon", "38996": "Saturn", "66": "Amazon",
  "31376": "PcComponentes", "31796": "Worten", "44": "Ebay",
  "54184": "Temu", "34210": "AliExpress"
},
"AmazonCountryMapping": { "es": "9326", "de": "9668", "fr": "9671", ... },
"WortenCountryMapping": { "WRT_ES_ONLINE": "9777", "WRT_PT_ONLINE": "9779" },
"EbayCountryMapping":   { "fr": "10104", "it": "10106", "de": "10108", "hu": "10118" }
```

- `ChannelMapping`: `channelId` de SF → nombre de marketplace.
- `<Marketplace>CountryMapping`: para Amazon, Worten y eBay, país → `customerId` del ERP.

Ver el detalle en [Mapeo y transformación](mp-mapeo.md#mapeo-de-canales-channel-marketplace).

---

## Filtro de estados de BD

```json
"DatabaseManagementSettings": {
  "OrderStatusFilter": "CREATED,IN_PROCESS,READY_FOR_SHIPPING"
}
```

Estados de `seguimiento_orders` que el [Worker Pedidos ERP → SF](mp-wf-pedidos-erp-sf.md) considera "pendientes de envío" y revisa en cada ejecución.

---

## Registro de control de procesos

```json
"ProcessHistorySettings": {
  "RootFolder": "/opt/UPG-ShoppingFeedConnector/Registros",
  "Creation": { "ProcessStats": { "RegistryFilename": "CREATE_ProcessDates.txt", "MaxRegisterCount": 150 }, ... },
  "Update":   { "ProcessStats": { "RegistryFilename": "UPDATE_ProcessDates.txt", "MaxRegisterCount": 150 },
                "SuccessRegistry": { "RegistryFilename": "UPDATE_SyncedOrders.txt", "RetentionPeriod": "DAILY" }, ... }
}
```

`RootFolder` debe ser **ruta absoluta** en producción (si no, en un servicio de Windows los ficheros caerían en `C:\Windows\System32`). Ver [Arquitectura → Registro de control](mp-arquitectura.md#registro-de-control-de-procesos).

---

## Diferencias dev / prod

| Aspecto | dev | prod |
|---|---|---|
| `isTest` | `true` | `false` |
| `status` SF | `""` (todos) | `waiting_shipment` |
| Logging | `Trace` + consola | `Information` |
| `UserSecrets` | activado | — |
| Salvaguarda test orders | desactivada (DEBUG) | activa (`#if RELEASE`) |

> Las credenciales reales (API de TEES, token de SF, contraseñas de BD) aparecen en los `appsettings` del repositorio. En un despliegue seguro conviene moverlas a **user secrets** (dev) o **variables de entorno / secretos** (prod) y no versionarlas.

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [Arquitectura del conector](mp-arquitectura.md) | Carga de configuración y entornos |
| [Mapeo y transformación](mp-mapeo.md) | Uso de `ChannelMapping` y `<Mkt>CountryMapping` |
| [Modelos de datos](mp-modelos.md) | Entidades de las BD configuradas aquí |
