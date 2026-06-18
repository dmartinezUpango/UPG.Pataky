# UPG.Pataky — Guía de estudio

Documentación técnica del sistema **UPG.Pataky**, una integración que sincroniza datos entre dos plataformas empresariales:

- **Provalliance / SalesLayer** (ERP + PIM) → origen de datos
- **Shopify B2B** → destino donde se publican productos, stock, clientes y pedidos

El sistema orquesta las sincronizaciones mediante workflows de [Elsa](https://elsa-workflows.github.io/elsa-core/) siguiendo el patrón ETL (Extract → Transform → Load).

## Documentación

**[→ Ver documentación completa](https://dmartinezupango.github.io/UPG.Pataky/)**

### Contenido

| # | Documento | Descripción |
|---|-----------|-------------|
| 01 | [Arquitectura ETL](https://dmartinezupango.github.io/UPG.Pataky/01-arquitectura-etl/) | El patrón Extract → Transform → Load y los proyectos del repo |
| 02 | [Motor de workflows (Elsa)](https://dmartinezupango.github.io/UPG.Pataky/02-elsa-workflows/) | Qué es Elsa y cómo se define un workflow en C# |
| 03 | [Workflows del sistema](https://dmartinezupango.github.io/UPG.Pataky/03-workflows-detalle/) | Los 6 workflows disponibles y su funcionamiento |
| 04 | [Extractors — visión general](https://dmartinezupango.github.io/UPG.Pataky/04-extractors/) · [detalle completo](https://dmartinezupango.github.io/UPG.Pataky/04b-extractors-detalle/) | Cómo se leen los datos de Provalliance, SalesLayer y FTP |
| 05 | [Transformers — visión general](https://dmartinezupango.github.io/UPG.Pataky/05-transformers/) · [detalle completo](https://dmartinezupango.github.io/UPG.Pataky/05b-transformers-detalle/) | Cómo se mapean los datos al formato Shopify con AutoMapper |
| 06 | [Modelos de datos](https://dmartinezupango.github.io/UPG.Pataky/06-modelos/) | Las entidades principales y sus relaciones |
| 07 | [Infraestructura y despliegue](https://dmartinezupango.github.io/UPG.Pataky/07-infraestructura/) | Docker Compose, contenedores y variables de entorno |
| 08 | [Configuración](https://dmartinezupango.github.io/UPG.Pataky/08-configuracion/) | El fichero `appsettings.json` explicado bloque a bloque |
| 09 | [Elsa Studio](https://dmartinezupango.github.io/UPG.Pataky/09-elsa-studio/) | La interfaz visual: monitorización, depuración y control |
| 10 | [Loaders y Mirror](https://dmartinezupango.github.io/UPG.Pataky/10-loaders/) | La capa de escritura en Shopify y la reconciliación de estado |

## Tecnologías

- **.NET 10** — runtime del servidor de workflows
- **Elsa Workflows 3.x** — motor de orquestación
- **Shopify GraphQL API** — destino de sincronización
- **PostgreSQL** — persistencia de estado de Elsa y tabla de transacciones
- **Docker Compose** — despliegue local y en producción

## Desarrollo local de la documentación

```bash
pip install mkdocs-material
mkdocs serve
```

El sitio se sirve en `http://127.0.0.1:8000`. Cualquier cambio en `docs/` se recarga automáticamente.

## Despliegue

El sitio se publica automáticamente en GitHub Pages con cada push a `main` mediante el workflow `.github/workflows/deploy.yml`.
