# UPG.Pataky — Guía de estudio

Bienvenido a la guía de estudio del proyecto **UPG.Pataky**. Esta serie de documentos te explicará paso a paso cómo funciona el sistema, desde el concepto general hasta los detalles de cada componente.

---

## ¿Qué es este proyecto?

**UPG.Pataky** es un sistema de integración que conecta dos plataformas empresariales:

- **Provalliance / SalesLayer** (origen): el ERP y PIM donde viven los datos reales de la empresa — clientes, productos, stock, pedidos e imágenes.
- **Shopify B2B** (destino): la tienda online donde esos datos tienen que aparecer sincronizados.

El proyecto se encarga de que ambos sistemas estén siempre alineados, ejecutando sincronizaciones automáticas y programadas.

---

## Índice de apartados

Cada apartado tiene (o tendrá) su propio documento con la explicación detallada.

### 1. Arquitectura general — el patrón ETL
> [`01-arquitectura-etl.md`](01-arquitectura-etl.md)

Cómo está organizado el código siguiendo el patrón **Extract → Transform → Load**. Los tres proyectos principales del repo y cómo se relacionan entre sí.

---

### 2. El motor de workflows: Elsa
> [`02-elsa-workflows.md`](02-elsa-workflows.md)

Qué es **Elsa**, para qué sirve un motor de workflows, y cómo este proyecto lo utiliza para orquestar las sincronizaciones. Cómo se define un workflow con código C#.

---

### 3. Los workflows del sistema
> [`03-workflows-detalle.md`](03-workflows-detalle.md)

Descripción detallada de cada uno de los **6 workflows** disponibles:

| Workflow | Dirección | Descripción |
|---|---|---|
| **Productos** | PIM → Shopify | Sincroniza el catálogo de productos |
| **Stock** | ERP → Shopify | Actualiza el inventario disponible |
| **Clientes** | ERP → Shopify | Sincroniza empresas, sucursales y contactos B2B |
| **Pedidos** | Shopify → ERP | Envía pedidos de Shopify al ERP |
| **Imágenes PIM** | FTP → PIM | Carga imágenes desde el FTP al PIM |
| **Imágenes Shopify** | PIM → Shopify | Publica imágenes de productos en Shopify |

---

### 4. Los Extractors — cómo se leen los datos del origen
> [`04-extractors.md`](04-extractors.md) — visión general
> [`04b-extractors-detalle.md`](04b-extractors-detalle.md) — detalle completo campo a campo

Cómo funciona la capa de extracción. Qué APIs consume (Provalliance, SalesLayer, FTP), cómo se autentica, y qué modelos de datos devuelve cada extractor con su estructura completa.

---

### 5. Los Transformers — cómo se convierten los datos
> [`05-transformers.md`](05-transformers.md) — visión general
> [`05b-transformers-detalle.md`](05b-transformers-detalle.md) — detalle completo campo a campo

Cómo se mapean los datos del ERP al formato que entiende Shopify. El uso de **AutoMapper** y los perfiles de mapeo. Todos los metafields que se generan y cómo se calculan los descuentos, imágenes y direcciones.

---

### 6. Los modelos de datos
> [`06-modelos.md`](06-modelos.md)

Los modelos principales del sistema: `ClientResponseModel`, `LocationResponseModel`, `ICompany`, `ILocation`, `ICustomer`, `IProduct`... y cómo se relacionan entre sí.

---

### 7. Infraestructura y despliegue
> [`07-infraestructura.md`](07-infraestructura.md)

Cómo se despliega el sistema con **Docker Compose**. Los contenedores que lo componen (servidor Elsa, Elsa Studio, PostgreSQL), cómo se construyen las imágenes y qué variables de entorno necesitan.

---

### 8. Configuración del sistema
> [`08-configuracion.md`](08-configuracion.md)

Explicación de todos los bloques del fichero `appsettings.json`: credenciales de Shopify, conexión al middleware de Provalliance, configuración del PIM SalesLayer, FTP de imágenes, notificaciones por email y programación de los workflows (cron).

---

### 9. Elsa Studio — la interfaz visual
> [`09-elsa-studio.md`](09-elsa-studio.md)

Qué es **Elsa Studio**, cómo se accede a él, qué puedes hacer desde la interfaz: ver el estado de los workflows, lanzarlos manualmente, ver los logs de ejecución y depurar errores.

---

### 10. Loaders y Mirror — la escritura y la reconciliación
> [`10-loaders.md`](10-loaders.md)

La capa de escritura y la capa de reconciliación: cómo cada Loader escribe en Shopify y registra el resultado en la BD de transacciones, y cómo las actividades Mirror leen el estado real de Shopify para mantener la BD alineada antes de tomar decisiones.

| Loader | Qué gestiona |
|---|---|
| `ProductsWithVariantsCreate` | Creación de productos+variantes (variante `$` centinela, exclusión de mercados) |
| `ProductsWithVariantsUpdate` | Actualización (incluyendo `RebuildProductOptions` con variante centinela `$`) |
| `ProductsWithVariantsDelete` | Borrado inteligente: promueve a borrado de producto si es la última variante |
| `PriceListsB2B` | Catálogos + PriceLists + Publicaciones + QuantityPriceBreaks |
| `ProductsMedias` | Imágenes: crea/actualiza/borra/asocia/desasocia, incrusta OriginId en ALT |
| `SyncStock` | Stock en 2 fases: UpdateVariants + InventorySetQuantities (lotes de 250) |
| `CompaniesWithContactsLoader` | 17 operaciones ordenadas: Company→Location→Contact→Role |
| `OrdersLoader` | Estado de pedidos: etiquetas, pagos, cancelaciones, fulfillments |

| Mirror | Qué reconcilia |
|---|---|
| `SyncProductsV2` | Productos + variantes + opciones (usa índices en memoria) |
| `SyncProductMedias` | Imágenes de productos (recupera OriginId del ALT) |
| `SyncPriceLists` | PriceLists + variantes asociadas |
| `SyncCompanies` | Companies + Locations + Contacts + Roles + agentes + customers |
| `MirrorMediasLoad` | Asignación imagen↔variante usando datos del PIM |

---

## Cómo leer esta guía

Se recomienda seguir el orden de los apartados la primera vez. Si ya tienes experiencia con algún concepto (por ejemplo, ya sabes qué es un motor de workflows), puedes saltar directamente al apartado que te interese.

El apartado más importante para entender el conjunto es el **1 (Arquitectura ETL)** porque da el marco mental sobre el que se construye todo lo demás.
