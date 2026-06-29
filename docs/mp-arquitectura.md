---
tags:
  - Marketplaces
  - Arquitectura
  - Worker
---

# Arquitectura del conector

UPG.Marketplaces es un **servicio en segundo plano de .NET** (`Microsoft.Extensions.Hosting`) que puede instalarse como **servicio de Windows** (`UseWindowsService`) o como unidad **systemd** en Linux (`UseSystemd`). Su responsabilidad es ejecutar, en intervalos programados, los cuatro procesos de sincronización entre eWheel y ShoppingFeed.

---

## Índice

1. [Arranque del servicio](#arranque-del-servicio)
2. [Inyección de dependencias](#inyeccion-de-dependencias)
3. [Registro y activación de Workers](#registro-y-activacion-de-workers)
4. [El motor de scheduling: `WorkerService<T>`](#el-motor-de-scheduling-workerservicet)
5. [Registro de control de procesos](#registro-de-control-de-procesos)
6. [Documentos relacionados](#documentos-relacionados)

---

## Arranque del servicio

El punto de entrada es `Program.Main()` (`UPG.Worker.Marketplaces/Program.cs`). Su secuencia es:

```text
1. Configurar NLog (nlog.config)
2. Construir el Host (CreateHostBuilder)
3. Aplicar migraciones de la BD de seguimiento:
   ApplicationEwheelDbContext.Database.Migrate()   ← MySQL
4. builder.Run()  → arranca los Workers registrados como HostedService
```

La migración automática (`Migrate()`) garantiza que la tabla `seguimiento_orders` (BD MySQL) existe antes de procesar pedidos.

### Configuración por entorno

La variable de entorno `DOTNET_ENVIRONMENT` decide qué fichero `appsettings.<env>.json` se carga sobre el base `appsettings.json`:

| Entorno | Fichero | Notas |
|---|---|---|
| `dev` (o vacío) | `appsettings.dev.json` | Activa `AddUserSecrets` y log por consola. `isTest=true` en SF |
| `prod` | `appsettings.prod.json` | StoreId de producción, `isTest=false` |

---

## Inyección de dependencias

Toda la composición de servicios ocurre en `ConfigureServices`. Lo esencial:

```csharp
// Configuraciones tipadas (IOptions<T>)
services.Configure<ShoppingFeedServiceSettings>(...);
services.Configure<EwheelServiceConfig>(...);
services.Configure<HagenServiceConfig>(...);
services.Configure<ProcessHistorySettings>(...);

// Dos DbContext con dos motores distintos
services.AddDbContext<EwheelDbContext>(o => o.UseSqlServer(...));            // Sage 200
services.AddDbContext<ApplicationEwheelDbContext>(o => o.UseMySql(...));     // seguimiento

// Servicios de integración
services.AddScoped<IEwheelService, EwheelService>();
services.AddScoped<IFeedService,  ShoppingFeedService>();
services.AddScoped<IRESTService,  ShoppingFeedAPIService>();
services.AddSingleton<ChannelMappingConfig>();
services.AddSingleton<CountryMappingFactory>();
services.AddAutoMapper(typeof(AutoMapperProfileShoppingFeed));
services.AddSingleton<IRegistryManager, FileRegistryManager>();
```

### Las dos bases de datos

El conector usa **dos `DbContext` con dos motores diferentes**:

| Contexto | Motor | Conexión | Uso |
|---|---|---|---|
| `EwheelDbContext` | SQL Server | `DefaultConnection` | Lectura directa de Sage 200: stock, tarifas y albaranes (vistas `VIS_TEES_*`) |
| `ApplicationEwheelDbContext` | MySQL | `ShoppingfeedConnection` | Tabla `seguimiento_orders`: estado de cada pedido entre SF y ERP |

### Nota sobre `IRESTService`

`IRESTService` se registra **varias veces** (Business Central, eWheel y ShoppingFeed). En .NET, cuando se resuelve un único `IRESTService` gana el **último registrado**, que es `ShoppingFeedAPIService` — el que necesita `ShoppingFeedService` como capa de transporte. `EwheelService` no depende de la resolución de `IRESTService`: hereda directamente de `RESTServiceBase`.

---

## Registro y activación de Workers

Los Workers se registran como `HostedService`, pero **condicionados por la directiva de compilación**:

```csharp
#if RELEASE
    services.AddHostedService<WorkerStockSync>();
    //services.AddHostedService<WorkerPricesSync>();   // desactivado
    services.AddHostedService<WorkerOrdersSFToERP>();
    services.AddHostedService<WorkerOrdersERPToSF>();
#else
    // En DEBUG todos están comentados: se activan manualmente al depurar
#endif
```

| Worker | ¿Activo en RELEASE? | Proceso |
|---|---|---|
| `WorkerStockSync` | ✅ | [Stock ERP → SF](mp-wf-stock.md) |
| `WorkerOrdersSFToERP` | ✅ | [Pedidos SF → ERP](mp-wf-pedidos-sf-erp.md) |
| `WorkerOrdersERPToSF` | ✅ | [Pedidos ERP → SF](mp-wf-pedidos-erp-sf.md) |
| `WorkerPricesSync` | ❌ (comentado) | [Precios ERP → SF](mp-wf-precios.md) |

> En `DEBUG`, además, `WorkerService<T>.ExecuteAsync()` ejecuta el job **inmediatamente** una vez (`#if DEBUG await RunWork(...)`) antes de entrar en el bucle de cron, para facilitar las pruebas.

---

## El motor de scheduling: `WorkerService<T>`

Todos los Workers heredan de la clase abstracta `WorkerService<T>` (`Helpers/WorkerService.cs`), que implementa `IHostedService` y aporta el bucle de programación cron. Cada Worker concreto solo implementa `DoWork(CancellationToken)`.

### Cómo programa la siguiente ejecución

```text
1. Lee el cron de configuración (sección con el nombre del Worker → "Cron")
2. Calcula la próxima ocurrencia con NCrontab (CrontabSchedule)
   · Si el cron tiene >5 campos → incluye segundos
3. await Task.Delay(hasta la próxima ocurrencia)
4. Si no hay una ejecución previa en curso (IsRunning) → DoWork()
   · Si la hay → registra "isRunning" y espera a la siguiente ocurrencia
5. Vuelve al paso 2
```

### Tolerancia a fallos

- Cada `DoWork` se envuelve en `RunWork`, que captura excepciones y marca `IsRunning = false` para no bloquear ejecuciones futuras.
- Si el bucle principal lanza una excepción, el servicio se **reintenta a sí mismo** hasta **5 veces** (`ErrorsCount < 5`); superado ese umbral, se detiene.
- Si un Worker **no tiene cron** configurado, se detiene en el arranque (registra el aviso en log).

### El objeto `Job`

Cada Worker construye en su constructor un objeto `Job` con `JobName`, `JobDesc`, `NumLimitLogs` y `CurrentTriggerConfig` (el cron), leídos de su sección de configuración. Sirve como metadatos del proceso para logging y monitorización.

---

## Registro de control de procesos

Los Workers de pedidos usan `IRegistryManager` (`FileRegistryManager`) para persistir en **ficheros de texto** la marca temporal de la última sincronización por operación (`SyncOperation`). Así, en cada ejecución se recupera la fecha del último procesamiento correcto y se piden a ShoppingFeed solo los pedidos cambiados *desde* esa fecha.

```text
ProcessHistorySettings:
  RootFolder: /opt/UPG-ShoppingFeedConnector/Registros
  Creation/Update:
    ProcessStats  → CREATE_ProcessDates.txt / UPDATE_ProcessDates.txt
    ErrorRegistry → CREATE_ErrorOrders.txt  / UPDATE_ErrorOrders.txt
    SuccessRegistry (Update) → UPDATE_SyncedOrders.txt
```

> En un servicio de Windows, sin `RootFolder` absoluto los ficheros se crearían en `C:\Windows\System32`. Por eso en producción `RootFolder` se rellena con una ruta absoluta.

---

## Documentos relacionados

| Documento | Contenido |
|---|---|
| [Visión general](mp-index.md) | Qué conecta el sistema y sus cuatro procesos |
| [Configuración](mp-configuracion.md) | Secciones de `appsettings.json` y crons |
| [Modelos de datos](mp-modelos.md) | `EwheelDbContext`, `ApplicationEwheelDbContext` y entidades |
