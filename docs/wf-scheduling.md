---
tags:
  - Workflows
  - Procesos
  - Scheduling
  - Cron
---

# WF-08 — SchedulingWorkflow

El `SchedulingWorkflow` es el **planificador central** del sistema. Lee los valores `Cron` de la configuración de cada workflow y registra los disparadores de ejecución automática. Está definido en el proyecto externo `ElsaShared` y se registra en `Program.cs`.

---

## Índice

1. [Registro en el servidor](#1-registro-en-el-servidor)
2. [Mecanismo de disparo](#2-mecanismo-de-disparo)
3. [Configuración de cron por workflow](#3-configuracion-de-cron-por-workflow)
4. [Ejecución manual desde Elsa Studio](#4-ejecucion-manual-desde-elsa-studio)
5. [Notas de diseño](#5-notas-de-diseno)

---

## 1. Registro en el servidor

```csharp title="Program.cs"
elsa.AddWorkflowsFrom<SchedulingWorkflow>(); // (1)!
```

1. `AddWorkflowsFrom<T>()` registra todos los workflows del assembly al que pertenece `SchedulingWorkflow`. Esto incluye el propio `SchedulingWorkflow` y otros workflows de `ElsaShared` como las actividades base y los workflows de notificación.

---

## 2. Mecanismo de disparo

El sistema usa **dos formas de disparar workflows**:

### Cron (automático)
`SchedulingWorkflow` registra un `CronTrigger` de Elsa (`useScheduling()`) para cada workflow cuyo campo `Cron` esté configurado con una expresión válida.

```text
Ejemplo: "Cron": "0 6 * * *"  →  todos los días a las 6:00
```

Cuando el cron se activa, Elsa ejecuta la instancia del workflow correspondiente.

### PublishEvent (manual o encadenado)
Cada workflow está también registrado con un trigger de tipo `PublishEvent(name)`, donde `name` es el nombre del workflow. Esto permite disparar un workflow:
- **Manualmente** desde Elsa Studio (botón "Run")
- **Desde otro workflow** usando la actividad `PublishEvent` con el nombre correspondiente

```text
PublishEvent("Productos")     → dispara ProductsWorkflow
PublishEvent("Stock")         → dispara StockWorkflow
PublishEvent("Clientes")      → dispara CompaniesWorkflow
PublishEvent("Pedidos")       → dispara OrdersWorkflow
PublishEvent("Imágenes")      → dispara ImagenesShopifyWorkflow
PublishEvent("CSV de imágenes para Sales Layer") → dispara PicsWorkflow
```

---

## 3. Configuración de cron por workflow

```json title="appsettings.json"
"Workflows": {
  "Products":       { "Name": "Productos",                        "Cron": null },
  "Stock":          { "Name": "Stock",                            "Cron": null },
  "Customers":      { "Name": "Clientes",                         "Cron": null },
  "Orders":         { "Name": "Pedidos",                          "Cron": null },
  "ImagesToShopify":{ "Name": "Imágenes hacia Shopify",           "Cron": null },
  "ImagesToPIM":    { "Name": "CSV de imágenes para Sales Layer", "Cron": null }
}
```

Todos los workflows tienen `Cron: null` en la configuración base. Los entornos de producción los sustituyen en `appsettings.Production.json` con las expresiones cron correspondientes.

### Formato de expresión cron (Elsa)

Elsa usa expresiones cron estándar de 5 campos:

```text
┌───────────── minuto     (0-59)
│ ┌─────────── hora       (0-23)
│ │ ┌───────── día-mes    (1-31)
│ │ │ ┌─────── mes        (1-12)
│ │ │ │ ┌───── día-semana (0-6, 0=domingo)
│ │ │ │ │
* * * * *
```

| Ejemplo | Descripción |
|---|---|
| `0 6 * * *` | Todos los días a las 6:00 |
| `0 */4 * * *` | Cada 4 horas |
| `0 8,14,20 * * 1-5` | Lunes a viernes a las 8:00, 14:00 y 20:00 |
| `null` | Sin programación automática |

---

## 4. Ejecución manual desde Elsa Studio

Desde la interfaz de Elsa Studio se puede disparar cualquier workflow manualmente:

1. Acceder a **Workflow Definitions**
2. Buscar el workflow por nombre
3. Hacer clic en **Run** (ejecutar instancia)

Alternativamente, desde la sección **Workflow Instances** se puede ver el historial de ejecuciones, los logs de cada actividad y reintentar ejecuciones fallidas.

---

## 5. Notas de diseño

### Separación de configuración y lógica

El `SchedulingWorkflow` separa la lógica de scheduling de la lógica de negocio: cada workflow conoce su propia lógica ETL, pero delega en el SchedulingWorkflow cuándo ejecutarse. Cambiar la frecuencia de un workflow es solo cambiar un campo en `appsettings.json`.

### `IncrementalCron`

La configuración incluye un campo `IncrementalCron` junto a `Cron`:

```json
"Stock": { "Cron": "0 6 * * *", "IncrementalCron": "0 */2 * * *" }
```

`IncrementalCron` permite configurar una frecuencia mayor para ejecuciones incrementales (solo los cambios recientes) vs. el full-sync de `Cron`. Actualmente ningún workflow implementa modo incremental — el campo está reservado para uso futuro.

### Retención de instancias

El servidor configura la eliminación automática de instancias de workflow finalizadas con más de 30 días:

```csharp
elsa.UseRetention(r =>
{
    r.SweepInterval = TimeSpan.FromHours(1);
    r.AddDeletePolicy("Delete finished workflows", sp => ...threshold = 30 days...);
});
```
