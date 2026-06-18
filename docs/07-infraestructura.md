# 07 — Infraestructura y despliegue

Este documento describe cómo se construye, empaqueta y despliega el sistema. Cubre Docker Compose, cada contenedor, la cadena de imágenes Docker, las variables de entorno, el sistema de logging y las diferencias entre el entorno de desarrollo y producción.

---

## Índice

1. [Visión general del sistema de contenedores](#1-vision-general-del-sistema-de-contenedores)
2. [La cadena de imágenes Docker](#2-la-cadena-de-imagenes-docker)
3. [Contenedor: pataky-server](#3-contenedor-pataky-server)
4. [Contenedor: pataky-studio](#4-contenedor-pataky-studio)
5. [Contenedor: pataky-postgres](#5-contenedor-pataky-postgres)
6. [Imágenes de soporte (shared-utils, shopify-sdk, pataky-partial)](#6-imagenes-de-soporte)
7. [Variables de entorno y fichero .env](#7-variables-de-entorno-y-fichero-env)
8. [Diferencias entre entornos](#8-diferencias-entre-entornos)
9. [Networking y comunicación entre contenedores](#9-networking-y-comunicacion-entre-contenedores)
10. [Persistencia de datos y volúmenes](#10-persistencia-de-datos-y-volumenes)
11. [Stack tecnológico: paquetes NuGet](#11-stack-tecnologico-paquetes-nuget)
12. [Cómo arrancar el sistema localmente](#12-como-arrancar-el-sistema-localmente)

---

## 1. Visión general del sistema de contenedores

El sistema corre completamente en **Docker**. Hay dos ficheros Docker Compose:

| Fichero | Propósito |
|---|---|
| `docker-compose.yml` | Entorno de desarrollo: incluye el proceso de build de imágenes |
| `docker-compose.Production.SalonSpace.yml` | Producción: usa imágenes ya construidas del registry, sin rebuild |

En ejecución normal hay **tres contenedores activos** (los dos de producción):

```
┌─────────────────────────────────────────────────────────────────┐
│  Host (servidor Linux o Windows)                                │
│                                                                 │
│  ┌──────────────────┐   ┌──────────────────┐                   │
│  │  pataky-server   │   │  pataky-studio   │                   │
│  │  :5271           │   │  :5270           │                   │
│  │  (API + Elsa)    │   │  (UI visual)     │                   │
│  └────────┬─────────┘   └────────┬─────────┘                   │
│           │                      │                             │
│           └──────────┬───────────┘                             │
│                      │                                         │
│           ┌──────────▼──────────┐                              │
│           │  pataky-postgres    │                              │
│           │  :5432              │                              │
│           │  (PostgreSQL 17.2)  │                              │
│           └─────────────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
```

El contenedor `pataky-studio` se conecta al API de `pataky-server` para mostrar la UI. El `pataky-server` se conecta a `pataky-postgres` para persistir el estado de Elsa y las transacciones.

---

## 2. La cadena de imágenes Docker

La construcción del `pataky-server` usa una cadena de imágenes en capas. Es importante entender el orden porque cada capa depende de las anteriores.

```
upango/dotnet-builder:ci          ← imagen base de CI con .NET SDK
         │
         ├── upango/shared-utils        ← librería SharedUtils
         ├── upango/shopify-sdk         ← SDK de Shopify
         ├── upango/saleslayer          ← conector SalesLayer PIM
         ├── upango/connector-google    ← conector Google
         └── upango/graph-library       ← librería Graph (Microsoft)
                    │
                    └── upango/comunes      ← une todos los anteriores en un FS
                                 │
         ┌───────────────────────┤
         │                       │
upango/pataky-partial         upango/comunes
(el código de UPG.Pataky)    (todas las libs comunes)
         │                       │
         └───────────────────────┘
                       │
               upango/pataky-server    ← la imagen final del servidor
```

Cada nivel del árbol es una imagen Docker independiente. Las imágenes de nivel bajo (`shared-utils`, `shopify-sdk`, etc.) se construyen en sus propios repositorios y se publican al registry de Upango. El `pataky-server` las consume como capas.

---

### `Dockerfile.partial` — el código específico del cliente

```dockerfile
FROM upango/dotnet-builder:ci
WORKDIR /src
COPY . .
```

El Dockerfile más simple del sistema. Solo copia el código de `UPG.Pataky` (el repositorio con Extractors, Transformers, Workflows y ElsaServer) al sistema de ficheros de la imagen, sin compilar. La compilación ocurre en el `Dockerfile` del servidor.

La imagen resultante se llama `upango/pataky-partial`.

---

### `Dockerfile.comunes` — las librerías comunes

```dockerfile
FROM upango/shared-utils AS shared-utils
FROM upango/shopify-sdk AS shopify-sdk
FROM upango/saleslayer AS saleslayer
FROM upango/connector-google AS connector-google
FROM upango/graph-library AS graph-library

FROM upango/dotnet-builder:ci
WORKDIR /src
COPY --from=shared-utils /src ./UPG.SharedUtils
COPY --from=shopify-sdk  /src ./UPG.ShopifySDK
COPY --from=saleslayer   /src ./UPG.Connector.SalesLayer
COPY --from=connector-google /src ./UPG.Connector.Google
COPY --from=graph-library /src ./GraphLibrary
```

Coge cinco imágenes de librerías diferentes y las combina en un único sistema de ficheros estructurado. El resultado es una imagen con todos los proyectos de `C:\Repos\Comunes\` disponibles en `/src/`.

La imagen resultante se llama `upango/comunes`.

---

### `Dockerfile` (en `UPG.Pataky.Shared`) — el servidor principal

Este es el Dockerfile más complejo. Usa **multi-stage build** con seis etapas:

```dockerfile
# Etapa 1: base de runtime (imagen pequeña, solo aspnet)
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
WORKDIR /app
EXPOSE 8080
EXPOSE 8081
# Optimizaciones de memoria del GC
ENV DOTNET_gcServer=1
ENV DOTNET_gcConcurrent=1
ENV DOTNET_GCHeapHardLimitPercent=0x55   # 85% de la RAM disponible

# Etapa 2: importar las librerías comunes
FROM upango/comunes AS comunes

# Etapa 3: importar el código específico del cliente
FROM upango/pataky-partial AS pataky-partial

# Etapa 4: montar la estructura de ficheros completa
FROM scratch AS estructura-pataky
COPY --from=comunes        /src  /src/Comunes
COPY .                           /src/Comunes/UPG.Pataky.Shared
COPY --from=pataky-partial /src  /src/UPANGO/Elsa/UPG.Pataky

# Etapa 5: compilar
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
COPY --from=estructura-pataky /src /src
WORKDIR /src/UPANGO/Elsa/UPG.Pataky/ElsaServer
RUN dotnet restore "ElsaServer.csproj"
RUN dotnet build   "ElsaServer.csproj" -c Release -o /app/build

# Etapa 6: publicar
FROM build AS publish
RUN dotnet publish "ElsaServer.csproj" -c Release -o /app/publish /p:UseAppHost=false

# Etapa final: imagen mínima con solo el binario publicado
FROM base AS final
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "ElsaServer.dll"]
```

**Por qué multi-stage:** Docker construye la imagen en etapas pero solo la etapa `final` va al contenedor. Las etapas intermedias de build y compilación (con el SDK de .NET, que pesa ~800 MB) se descartan. La imagen final solo contiene el runtime de ASP.NET (~220 MB) y los binarios compilados.

**La estructura de carpetas montada en `estructura-pataky`:**

```
/src/
├── Comunes/
│   ├── UPG.SharedUtils/
│   ├── UPG.ShopifySDK/
│   ├── UPG.Connector.SalesLayer/
│   ├── UPG.Connector.Google/
│   ├── GraphLibrary/
│   └── UPG.Pataky.Shared/       ← el proyecto de servicios compartidos
└── UPANGO/Elsa/UPG.Pataky/
    ├── ElsaServer/               ← punto de entrada, el .csproj principal
    ├── Extractors/
    ├── Transformers/
    ├── Decisions/
    └── Workflows/
```

Esta estructura espeja exactamente la estructura de `C:\Repos\` en local, por lo que los `<ProjectReference>` del `.csproj` funcionan igual en Docker que en local.

**Optimizaciones de memoria configuradas:**

| Variable | Valor | Efecto |
|---|---|---|
| `DOTNET_gcServer=1` | Server GC activo | Usa múltiples threads para el garbage collector, mejor throughput |
| `DOTNET_gcConcurrent=1` | GC concurrente | El GC trabaja en paralelo con el código de la aplicación |
| `DOTNET_GCHeapHardLimitPercent=0x55` | 85% de RAM | El GC no usará más del 85% de la memoria disponible — evita OOM kills del sistema operativo |

---

## 3. Contenedor: pataky-server

Es el contenedor principal. Ejecuta el servidor de **Elsa Workflows** con todos los workflows, activities, extractors, transformers y loaders.

**Configuración en docker-compose (producción):**

```yaml
pataky-server:
  image: upango/pataky-server:latest
  container_name: pataky-server
  restart: unless-stopped
  extra_hosts:
    - "host.docker.internal:host-gateway"
  ports:
    - 5271:8080
  env_file:
    - .env
  volumes:
    - ./logs:/app/logs
  environment:
    TZ: ${TIME_ZONE}
    ASPNETCORE_ENVIRONMENT: ${ASPNETCORE_ENVIRONMENT}
    BUSINESS_TYPE: ${BUSINESS_TYPE}
    Elsa__Persistence__ConnectionString: "Host=..."
    Elsa__Persistence__DatabaseProvider: "PostgreSql"
    Transactions__ConnectionString: "Host=..."
```

**Puertos:**
- `5271` en el host → `8080` dentro del contenedor
- La API de Elsa escucha en `http://0.0.0.0:8080/elsa/api`

**`restart: unless-stopped`:** el contenedor se reinicia automáticamente si falla o si se reinicia el servidor, excepto si fue detenido manualmente.

**`extra_hosts: host.docker.internal:host-gateway`:** permite al contenedor acceder al host del servidor usando `host.docker.internal` como nombre DNS. Usado en entornos donde el servidor de base de datos está en el host en lugar de en otro contenedor.

**`volumes: ./logs:/app/logs`:** monta la carpeta `./logs/` del host dentro del contenedor en `/app/logs`. Los logs de Serilog se escriben en `/app/logs/` dentro del contenedor y son accesibles desde el host. En desarrollo este volumen no está configurado.

**Variables de entorno inyectadas directamente** (sobreescriben el `appsettings.json`):

| Variable | Descripción |
|---|---|
| `TZ` | Zona horaria del sistema (`Europe/Madrid`). Afecta a todos los `DateTime.Now` y a los crons. |
| `ASPNETCORE_ENVIRONMENT` | Activa el `appsettings.{Environment}.json` correspondiente |
| `BUSINESS_TYPE` | Tipo de negocio (`B2B` o `SalonSpace`). Controla comportamientos condicionales del código |
| `Elsa__Persistence__ConnectionString` | Cadena de conexión a la BD `elsa-*` (estado de workflows) |
| `Elsa__Persistence__DatabaseProvider` | Siempre `"PostgreSql"` en producción |
| `Transactions__ConnectionString` | Cadena de conexión a la BD `transactions-*` (pares OriginId↔DestinoId) |

> **Nota sobre los dobles guiones bajos**: en ASP.NET Core, la notación `Elsa__Persistence__ConnectionString` en variables de entorno equivale a `Elsa:Persistence:ConnectionString` en el JSON. Los `__` son el separador de secciones jerárquicas.

---

## 4. Contenedor: pataky-studio

Es la interfaz visual de Elsa. Un servidor web que sirve la aplicación **Blazor WebAssembly** de Elsa Studio. Solo consume la API del servidor — no tiene acceso a base de datos ni a ningún sistema externo.

**`ElsaStudio.Dockerfile`:**

```dockerfile
FROM upango/dotnet-builder:ci AS build
WORKDIR /src
COPY ./ElsaStudio.WebAssembly ./ElsaStudio.WebAssembly
COPY ./ElsaStudio.Web ./ElsaStudio.Web

RUN dotnet restore "./ElsaStudio.WebAssembly/ElsaStudio.WebAssembly.csproj"
RUN dotnet restore "./ElsaStudio.Web/ElsaStudio.Web.csproj"

WORKDIR /src/ElsaStudio.Web
RUN dotnet build   "ElsaStudio.Web.csproj" -c Release -o /app/build
RUN dotnet publish "ElsaStudio.Web.csproj" -c Release -o /app/publish /p:UseAppHost=false --no-restore -f net10.0

FROM upango/dotnet-runtime:ci AS base
WORKDIR /app
COPY --from=build /app/publish ./
EXPOSE 8080/tcp
EXPOSE 443/tcp
ENTRYPOINT ["dotnet", "ElsaStudio.Web.dll"]
```

**Configuración en docker-compose:**

```yaml
pataky-studio:
  image: upango/pataky-studio:latest
  container_name: pataky-studio
  depends_on:
    - pataky-server
  restart: unless-stopped
  ports:
    - 5270:8080
  environment:
    TZ: ${TIME_ZONE}
    HostingBasePath: "http://${HOST}:5270"
    ElsaServerUrl:   "http://${HOST}:5271/elsa/api"
```

**Puertos:**
- `5270` en el host → `8080` dentro del contenedor
- Acceso desde el navegador: `http://{HOST}:5270`

**Variables de entorno:**

| Variable | Descripción |
|---|---|
| `HostingBasePath` | La URL base donde está servida la UI. Necesaria para que las rutas de Blazor WebAssembly funcionen correctamente |
| `ElsaServerUrl` | La URL completa de la API de Elsa a la que se conecta la UI. Debe ser accesible desde el navegador del usuario, no desde el contenedor |

**`depends_on: pataky-server`:** Docker Compose espera a que el contenedor `pataky-server` esté en estado "running" antes de iniciar `pataky-studio`. No garantiza que la API esté lista (solo que el proceso ha arrancado), pero en la práctica es suficiente.

---

## 5. Contenedor: pataky-postgres

Es la base de datos PostgreSQL. Contiene dos bases de datos lógicas dentro del mismo servidor:

| Base de datos | Propósito | Se configura en |
|---|---|---|
| `elsa-provalliance` / `elsa` | Estado de Elsa: definiciones de workflows, instancias, variables, triggers | `Elsa__Persistence__ConnectionString` |
| `transactions-provalliance` / `transactions` | Pares OriginId↔DestinoId de todas las entidades sincronizadas | `Transactions__ConnectionString` |

**Configuración en docker-compose (solo en desarrollo):**

```yaml
pataky-postgres:
  image: postgres:17.2-alpine
  container_name: pataky-postgres
  restart: always
  ports:
    - ${POSTGRES_PORT}:5432
  env_file:
    - .env
  environment:
    TZ: ${TIME_ZONE}
```

- La imagen es `postgres:17.2-alpine` — la variante Alpine es más ligera (~80 MB vs ~350 MB de la imagen base de Debian).
- El puerto `${POSTGRES_PORT}` del host se mapea al `5432` interno, permitiendo conectarse desde herramientas externas como DBeaver o TablePlus.
- Las credenciales las recibe a través del `env_file`, que le pasa las variables `POSTGRES_USER` y `POSTGRES_PASSWORD` que PostgreSQL reconoce automáticamente para crear el usuario inicial.

> **En producción** el contenedor de PostgreSQL no está en el `docker-compose.Production.SalonSpace.yml` — la BD está en un servidor PostgreSQL externo (IP `<IP_SERVIDOR>`) accesible directamente desde la red del host.

---

## 6. Imágenes de soporte

Estas imágenes existen solo para facilitar la construcción. En tiempo de ejecución no hay contenedor activo para ellas.

### `shared-utils` y `shopify-sdk`

```yaml
shared-utils:
  image: upango/shared-utils:latest
  build:
    context: ../../../Comunes/UPG.SharedUtils
    dockerfile: ./Dockerfile
  command: /bin/bash -c exit   # ← termina inmediatamente

shopify-sdk:
  image: upango/shopify-sdk:latest
  build:
    context: ../../../Comunes/UPG.ShopifySDK
    dockerfile: ./Dockerfile
  command: /bin/bash -c exit
```

`command: /bin/bash -c exit` hace que el contenedor arranque y se cierre al instante. El propósito es solo **construir la imagen** para que esté disponible en el registry local cuando la referencia el Dockerfile del servidor.

### `pataky-partial`

```yaml
pataky-partial:
  image: upango/pataky-partial:latest
  build:
    context: .
    dockerfile: ./Dockerfile.partial
  command: /bin/bash -c exit
```

Construye la imagen con el código de `UPG.Pataky` (este repositorio). El `context: .` significa que el directorio de build es la raíz del repositorio.

---

## 7. Variables de entorno y fichero .env

El fichero `.env` en la raíz del repositorio define todas las variables de entorno que usa Docker Compose. Hay **dos ficheros `.env`** según el entorno:

### `.env` — Desarrollo local

```
TIME_ZONE=Europe/Madrid
ASPNETCORE_ENVIRONMENT=Development
HOST=localhost
POSTGRES_HOST=pataky-postgres   # nombre del contenedor (DNS interno de Docker)
POSTGRES_PORT=5432
POSTGRES_USER=root
POSTGRES_PASSWORD=root
ELSA_DB=elsa-b2b
TRANSACTIONS_DB=transactions-b2b
BUSINESS_TYPE=B2B
```

### `.env.Production.SalonSpace` — Producción

```
TIME_ZONE=Europe/Madrid
ASPNETCORE_ENVIRONMENT=Production
HOST=<IP_SERVIDOR>                  # IP del servidor en producción
POSTGRES_HOST=<IP_SERVIDOR>         # PostgreSQL externo
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<POSTGRES_PASSWORD>
ELSA_DB=elsa
TRANSACTIONS_DB=transactions
BUSINESS_TYPE=SalonSpace
```

**Descripción de cada variable:**

| Variable | Tipo | Descripción |
|---|---|---|
| `TIME_ZONE` | string | Zona horaria del contenedor. Afecta a `DateTime.Now`, los crons y las marcas de tiempo en los logs. En España peninsular siempre `Europe/Madrid`. |
| `ASPNETCORE_ENVIRONMENT` | enum | `Development`, `Staging` o `Production`. ASP.NET Core usa este valor para cargar el fichero `appsettings.{Environment}.json` correspondiente, que sobreescribe valores del `appsettings.json` base. |
| `HOST` | string | IP o DNS del servidor donde corre Elsa. El Studio lo usa para construir la URL de la API (`ElsaServerUrl`). En local es `localhost`; en producción es la IP del servidor. |
| `POSTGRES_HOST` | string | Host del servidor PostgreSQL. En desarrollo es `pataky-postgres` (nombre del contenedor, resuelto por la red interna de Docker). En producción es una IP externa. |
| `POSTGRES_PORT` | int | Puerto de PostgreSQL. Casi siempre `5432`. Se mapea tal cual al host en desarrollo para acceso externo. |
| `POSTGRES_USER` | string | Usuario de PostgreSQL. |
| `POSTGRES_PASSWORD` | string | Contraseña de PostgreSQL. |
| `ELSA_DB` | string | Nombre de la base de datos para el estado de Elsa. |
| `TRANSACTIONS_DB` | string | Nombre de la base de datos para el seguimiento de sincronizaciones. |
| `BUSINESS_TYPE` | string | Tipo de negocio. Controla comportamientos condicionales en el código que difieren entre instalaciones. |

---

## 8. Diferencias entre entornos

El sistema usa el mecanismo estándar de ASP.NET Core: el fichero `appsettings.json` es la base, y `appsettings.{Environment}.json` sobreescribe solo los valores específicos de ese entorno.

```
appsettings.json                         ← valores base y defaults
  ├── appsettings.Development.json       ← sobreescribe para Development
  └── appsettings.Production.SalonSpace.json  ← sobreescribe para Production
```

**`appsettings.json` — valores base:**
- Conexiones a PostgreSQL de desarrollo (localhost:36220)
- Credenciales de SalesLayer PIM (CanalEntrada y CanalSalida)
- Configuración FTP de imágenes
- Shopify con valores vacíos (se rellenan por entorno)
- Credenciales de Provalliance Middleware (Azure API Management)
- Crons de todos los workflows: `null` (no se ejecutan automáticamente sin configurar)
- Filtro de pedidos: `"tag_not:Sincronizado"`

**`appsettings.Development.json` — sobreescrituras de desarrollo:**
- Solo sobreescribe `ShopifyCredentials` con la tienda de pruebas de Domingo
- Todo lo demás hereda del base

**`appsettings.Production.SalonSpace.json` — sobreescrituras de producción:**
- Conexión a Elsa BD y Transactions en el servidor de producción (<IP_SERVIDOR>)
- `SigningKey` de Elsa Identity (llave real, más larga y segura)
- Usuario de Elsa admin con credenciales reales (`provalliance`/`<ELSA_ADMIN_PASSWORD>`)
- Shopify apuntando a `<TIENDA>.myshopify.com`
- Tag de agentes: `["agente"]`
- Credenciales de Microsoft Graph para envío de emails
- **Crons activos:**

| Workflow | Cron | Frecuencia |
|---|---|---|
| Productos | `0 0 * * * *` | Cada hora en punto |
| ImagesToPIM | `0 * * * * *` | Cada minuto |
| ImagesToShopify | `0 30 * * * *` | Cada hora y media |
| Stock | `0 */10 4-21 * * *` | Cada 10 minutos entre las 4:00 y las 21:59 |
| Clientes | `0 15 * * * *` | Cada hora a las :15 |
| Pedidos | `0 */5 * * * *` | Cada 5 minutos |

> **El cron de Stock** (`0 */10 4-21 * * *`) merece una explicación: el ERP actualiza el stock cada 10 minutos entre las 6:04 y las 21:44. El cron cubre un rango más amplio (4:00-21:59) para absorber cambios de hora (verano/invierno) sin necesidad de reconfigurar.

---

## 9. Networking y comunicación entre contenedores

Docker Compose crea automáticamente una **red interna** para todos los servicios definidos en el mismo fichero. Dentro de esta red, cada contenedor puede acceder a los demás usando el **nombre del servicio** como nombre DNS.

```
pataky-server → "pataky-postgres" → resuelve a la IP del contenedor PostgreSQL
pataky-studio → "pataky-server"   → pero ¡CUIDADO! (ver abajo)
```

**El problema de `pataky-studio`:**

`pataky-studio` sirve una aplicación **Blazor WebAssembly** (WASM). Esto significa que el código JavaScript se descarga al navegador del usuario y se ejecuta en su máquina, no en el servidor. Cuando el navegador intenta conectarse al servidor Elsa, lo hace desde la máquina del usuario, no desde la red Docker.

Por eso `ElsaServerUrl` usa la variable `${HOST}` (una IP o DNS accesible desde el exterior) en lugar de `pataky-server` (que solo funcionaría dentro de la red Docker):

```
# Mal (solo funciona dentro de Docker):
ElsaServerUrl: "http://pataky-server:8080/elsa/api"

# Bien (accesible desde el navegador):
ElsaServerUrl: "http://<IP_SERVIDOR>:5271/elsa/api"
```

**`extra_hosts: host.docker.internal:host-gateway`** (solo en producción):

Esta directiva añade una entrada al `/etc/hosts` del contenedor que mapea `host.docker.internal` a la IP de la interfaz de red del host. Permite al contenedor `pataky-server` conectarse a servicios corriendo directamente en el host (fuera de Docker), usando `host.docker.internal` como hostname.

---

## 10. Persistencia de datos y volúmenes

El sistema usa dos tipos de persistencia:

### Base de datos PostgreSQL

La persistencia de la BD depende de si PostgreSQL corre en Docker o en un servidor externo:

- **Desarrollo (PostgreSQL en Docker):** el contenedor `pataky-postgres` usa el almacenamiento interno del contenedor. Si se borra el contenedor, se pierden los datos. Para persistir datos en desarrollo habría que añadir un volumen explícito (`./data:/var/lib/postgresql/data`), pero en el `docker-compose.yml` actual no está configurado — se asume que el entorno de desarrollo es efímero.

- **Producción (PostgreSQL externo):** la BD está en un servidor externo (IP `<IP_SERVIDOR>`), fuera de Docker. La persistencia la gestiona ese servidor directamente.

### Logs del servidor

```yaml
volumes:
  - ./logs:/app/logs
```

Solo en el fichero de producción. Los logs de Serilog se escriben en `/app/logs/` dentro del contenedor y se mapean a `./logs/` en el host (junto al `docker-compose.yml`). Esto permite acceder a los logs desde el host sin entrar al contenedor.

El sistema de logging usa **Serilog** con dos sinks configurados:
- **Console**: para ver los logs en tiempo real con `docker logs pataky-server`
- **Fichero**: para persistencia en disco

### Logs de Elsa (en BD)

Elsa guarda el historial de ejecución de cada workflow en la BD `elsa-*`. Esto incluye:
- Qué workflows se han ejecutado y cuándo
- En qué estado terminaron (completado, error, cancelado)
- Qué variables tenían en cada paso
- Los logs de cada actividad

La política de retención de estos registros se configura con `Elsa.Retention` (paquete instalado en el `.csproj`).

---

## 11. Stack tecnológico: paquetes NuGet

El `ElsaServer.csproj` declara todas las dependencias del servidor. Aquí están explicadas:

### Elsa Workflows 3.6.2

| Paquete | Versión | Propósito |
|---|---|---|
| `Elsa` | 3.6.2 | Núcleo del motor de workflows |
| `Elsa.Workflows.Core` | 3.6.2 | Definición de workflows y activities en código C# |
| `Elsa.Workflows.Api` | 3.6.2 | Endpoints REST para la API de Elsa (que consume Elsa Studio) |
| `Elsa.Scheduling` | 3.6.2 | Soporte de triggers de tiempo y crons |
| `Elsa.Identity` | 3.6.2 | Autenticación y autorización de la API de Elsa |
| `Elsa.Http` | 3.6.2 | Actividades HTTP y triggers HTTP |
| `Elsa.Expressions.CSharp` | 3.6.2 | Permite escribir expresiones C# en el Studio |
| `Elsa.Persistence.EFCore.PostgreSql` | 3.6.2 | Persistencia de Elsa en PostgreSQL |
| `Elsa.Persistence.EFCore.Sqlite` | 3.6.2 | Persistencia de Elsa en SQLite (usado en tests o dev) |
| `Elsa.Retention` | 3.6.1 | Política de borrado de historial de workflows |

### Base de datos

| Paquete | Versión | Propósito |
|---|---|---|
| `Microsoft.EntityFrameworkCore.Design` | 10.0.1 | Herramientas de diseño de EF Core (generación de migraciones) |
| `Microsoft.EntityFrameworkCore.Tools` | 10.0.1 | Comandos CLI de EF Core (`dotnet ef`) |

### HTTP y red

| Paquete | Versión | Propósito |
|---|---|---|
| `RestSharp` | 112.1.0 | Cliente HTTP para las llamadas al ERP Provalliance y al PIM SalesLayer |
| `Kveer.XmlRPC` | 1.3.1 | Cliente XML-RPC para la API antigua de SalesLayer (CanalEntrada) |

### Logging

| Paquete | Versión | Propósito |
|---|---|---|
| `Serilog.AspNetCore` | 10.0.0 | Integración de Serilog con ASP.NET Core |
| `Serilog.Extensions.Logging` | 10.0.0 | Puente entre la abstracción `ILogger` y Serilog |
| `Serilog.Sinks.Console` | 6.1.1 | Sink de consola (output de `docker logs`) |

### Referencias a proyectos locales

| Proyecto | Carpeta | Descripción |
|---|---|---|
| `ElsaShared.csproj` | `Comunes/UPG.Pataky.Shared/Shared/` | Servicios compartidos, interfaces, BD de transacciones |
| `ShopifySDK.csproj` | `Comunes/UPG.ShopifySDK/` | Cliente GraphQL de Shopify |
| `UPG.Connector.SalesLayer.csproj` | `Comunes/UPG.Connector.SalesLayer/` | Cliente de la API de SalesLayer |
| `Extractors.csproj` | `Extractors/` | Capa de extracción |
| `Transformers.csproj` | `Transformers/` | Capa de transformación |
| `Decisions.csproj` | `Decisions/` | Actividades de decisión (ramificación en workflows) |

> **Nota sobre el framework:** el proyecto usa **.NET 10.0** (`net10.0`) pero el Dockerfile del servidor todavía referencia imágenes de .NET 8 (`mcr.microsoft.com/dotnet/aspnet:8.0`). Hay una inconsistencia temporal — la imagen base del contenedor deberá actualizarse a .NET 10 en el siguiente despliegue.

---

## 12. Cómo arrancar el sistema localmente

### Requisitos previos

1. Docker Desktop instalado y corriendo
2. El repositorio `UPG.Pataky` clonado en `C:\Repos\Upango\Elsa\UPG.Pataky`
3. El repositorio `Comunes` clonado en `C:\Repos\Comunes\`
4. Acceso al registry de imágenes de Upango (para `upango/shared-utils`, `upango/shopify-sdk`, etc.)

### Arranque

```bash
# En la raíz del repositorio (C:\Repos\Upango\Elsa\UPG.Pataky)

# 1. Construir todas las imágenes y arrancar
docker-compose up --build

# 2. Solo arrancar sin reconstruir (si las imágenes ya están construidas)
docker-compose up

# 3. Solo el servidor (sin studio)
docker-compose up pataky-server pataky-postgres
```

### URLs disponibles

| Servicio | URL |
|---|---|
| Elsa Studio (UI) | `http://localhost:5270` |
| API de Elsa | `http://localhost:5271/elsa/api` |
| PostgreSQL | `localhost:5432` |

### Ver logs en tiempo real

```bash
# Logs del servidor
docker logs pataky-server -f

# Logs de todos los contenedores
docker-compose logs -f
```

### Parar el sistema

```bash
# Parar sin borrar contenedores
docker-compose stop

# Parar y borrar contenedores (los datos de PostgreSQL se pierden)
docker-compose down
```

---

## Siguiente paso

→ [`08-configuracion.md`](08-configuracion.md) — Explicación detallada de todos los bloques del `appsettings.json`
