---
tags:
  - Workflows
  - Procesos
  - Clientes
  - ERP
  - Shopify
  - B2B
---

# WF-03 — Clientes

Sincronización de clientes B2B desde el ERP (Provalliance) hacia Shopify. El workflow mantiene sincronizadas las entidades de la jerarquía B2B de Shopify: **Company** (empresa cliente), **CompanyLocation** (sucursal), **Customer** (contacto) y **CompanyContact** (asignación de contacto a empresa). Usa Mirror (`SyncCompanies` + `SyncPriceLists`) antes de la extracción para tener el estado actual de Shopify.

---

## Índice

1. [Resumen](#resumen)
2. [Grafo del workflow](#grafo-del-workflow)
3. [Actividades](#actividades)
4. [Variables del workflow](#variables-del-workflow)
5. [Configuración](#configuracion)
6. [Documentos relacionados](#documentos-relacionados)

---

## Resumen

| Campo | Valor |
|---|---|
| **Clase** | `CompaniesWorkflow` |
| **Fichero** | `ElsaServer/Workflows/CompaniesWorkflow.cs` |
| **Config key** | `Workflows:Customers` |
| **Dirección** | ERP (Provalliance) → Shopify B2B |
| **Trigger** | `PublishEvent("Clientes")` |
| **Cron** | `null` — solo ejecución manual desde Elsa Studio |
| **Incremental** | No |
| **Mirror** | Sí — `SyncCompanies` + `SyncPriceLists` |

---

## Grafo del workflow

=== ":material-graph: Interactivo"

    <div id="reactflow-root"></div>

    <div id="reactflow-data" style="display:none">
    {
      "height": 820,
      "nodes": [
        {"id":"erp",          "type":"input",  "data":{"label":"ERP Provalliance"},              "position":{"x":0,   "y":0}},
        {"id":"shopify_src",  "type":"input",  "data":{"label":"Shopify B2B API"},               "position":{"x":540, "y":0}},
        {"id":"sync1",                         "data":{"label":"SyncCompanies"},                  "position":{"x":540, "y":110}},
        {"id":"sync2",                         "data":{"label":"SyncPriceLists"},                 "position":{"x":540, "y":220}},
        {"id":"extract",                       "data":{"label":"CustomerExtract","url":"../wf-clientes-metodos/#1-customerextract-clase"},                "position":{"x":200, "y":340}},
        {"id":"decision",                      "data":{"label":"CustomerDecision"},               "position":{"x":200, "y":460}},
        {"id":"transform",                     "data":{"label":"CustomerTransform","url":"../wf-clientes-metodos/#3-customertransform-clase"},              "position":{"x":200, "y":580}},
        {"id":"loader",                        "data":{"label":"CompaniesWithContactsLoader"},    "position":{"x":200, "y":700}},
        {"id":"shopify_dst",  "type":"output", "data":{"label":"Shopify B2B API"},               "position":{"x":200, "y":820}}
      ],
      "edges": [
        {"id":"e1","source":"shopify_src","target":"sync1",       "label":"bulk query",                 "animated":true},
        {"id":"e2","source":"shopify_src","target":"sync2",       "label":"bulk query",                 "animated":true},
        {"id":"e3","source":"sync1",      "target":"sync2",       "label":"sync sequence"},
        {"id":"e4","source":"sync2",      "target":"extract"},
        {"id":"e5","source":"erp",        "target":"extract",     "label":"GetClients()",               "animated":true},
        {"id":"e6","source":"extract",    "target":"decision",    "label":"Box<ICompany>"},
        {"id":"e7","source":"decision",   "target":"transform",   "label":"12 variables"},
        {"id":"e8","source":"transform",  "target":"loader",      "label":"CompaniesWithContactsInput"},
        {"id":"e9","source":"loader",     "target":"shopify_dst", "label":"mutations",                  "animated":true}
      ]
    }
    </div>

=== ":material-chart-timeline-variant: Estático"

    ```mermaid
    flowchart LR
        ERP[("ERP Middleware\nProvalliance")]
        SHOPIFY[("Shopify B2B\nCompany API")]
        SYNC1["SyncCompanies\nBulk query Companies/Locations/Contacts\n→ TransactionsDB"]
        SYNC2["SyncPriceLists\nBulk query PriceLists\n→ TransactionsDB"]
        EX["CustomerExtract\nGetClients() del ERP\nFiltra leads y sin OriginId"]
        DEC["CustomerDecision\nCruza ERP con TransactionsDB\nCrear / Actualizar / Borrar\ncompanies, locations, contacts, roles"]
        TR["CustomerTransform\nAutoMapper → inputs Shopify\nMetafields, catálogos"]
        LD["CompaniesWithContactsLoader\nEjecuta todas las mutaciones\nen Shopify B2B"]

        SHOPIFY -. "bulk query" .-> SYNC1
        SYNC1 --> SYNC2
        SHOPIFY -. "bulk query" .-> SYNC2
        SYNC2 --> EX
        ERP -. "GetClients()" .-> EX
        EX -->|"Box&lt;ICompany&gt; ERPCompanies"| DEC
        DEC -->|"12 variables clasificadas"| TR
        TR -->|"CompaniesWithContactsInput inputLoader"| LD
        LD -. "mutations" .-> SHOPIFY
    ```

---

## Actividades

| # | Clave interna | Clase | Tipo | Propósito |
|---|---|---|---|---|
| 1 | `sync` | `SyncCompanies` *(Loaders)* | Mirror | Sincroniza Companies/Locations/Contacts de Shopify en TransactionsDB |
| 2 | `sync_price_list` | `SyncPriceLists` *(Loaders)* | Mirror | Sincroniza PriceLists de Shopify en TransactionsDB |
| 3 | `extraer` | `CustomerExtract` | Extractor | Lee clientes del ERP, filtra leads |
| 4 | `decision` | `CustomerDecision` *(Loaders)* | Decision | Clasifica empresas/sucursales/contactos en CRUD + asignaciones |
| 5 | `transformCustomers` | `CustomerTransform` | Transformer | Mapea datos ERP a inputs Shopify, genera metafields |
| 6 | `loadClientes` | `CompaniesWithContactsLoader` *(Loaders)* | Loader | Ejecuta todas las operaciones en Shopify B2B |

---

## Variables del workflow

| Variable | Tipo | Descripción |
|---|---|---|
| `ERPCompanies` | `Box<ICompany>` | Clientes extraídos del ERP |
| `createCompanies` | `Box<ICompany>` | Empresas nuevas a crear |
| `updateCompanies` | `Box<(string, ICompany)>` | Empresas a actualizar (DestinoId + datos) |
| `deleteCompanies` | `Box<string>` | DestinoIds de empresas a eliminar |
| `createLocations` | `Box<(string, ILocation)>` | Sucursales a crear (DestinoId empresa + datos) |
| `updateLocations` | `Box<(string, ILocation)>` | Sucursales a actualizar (DestinoId sucursal + datos) |
| `deleteLocations` | `Box<Location>` | Sucursales a eliminar |
| `createContacts` | `Box<(string, ICustomer)>` | Contactos a crear (DestinoId empresa + datos) |
| `updateContacts` | `Box<(string, ICustomer)>` | Contactos a actualizar (DestinoId CompanyContact + datos) |
| `deleteContacts` | `Box<string>` | DestinoIds de CompanyContacts a eliminar |
| `mainContactAssign` | `Box<(string, ICustomer)>` | Asignaciones de contacto principal por empresa |
| `assignRoles` | `Box<(string, ICustomer, ILocation)>` | Roles a asignar (contacto + sucursal) |
| `inputLoader` | `CompaniesWithContactsInput` | Input consolidado para `CompaniesWithContactsLoader` |

---

## Configuración

```json title="appsettings.json"
"ShopifyCredentials": {
  "DefaultPriceListId": "",
  "LeadPrefix": "LEAD#"
},
"Workflows": {
  "Customers": {
    "Name": "Clientes",
    "Cron": null,
    "IncrementalCron": null,
    "Notifications": {
      "Recipients": []
    }
  }
}
```

- `LeadPrefix`: clientes cuyo `OriginId` empieza por este prefijo se filtran y no se sincronizan.
- `DefaultPriceListId`: tarifa B2B asignada automáticamente a toda sucursal nueva.

---

## Documentos relacionados

| Documento | Descripción |
|---|---|
| [Detalle completo](wf-clientes-detalle.md) | Actividades, jerarquía B2B y lógica de decisión |
| [Métodos y funciones](wf-clientes-metodos.md) | Código anotado de `CustomerExtract` y `CustomerTransform` |
| [WF-07 — Tarifas B2B](wf-tarifas.md) | Sincronización de PriceLists integrada en este workflow |
| [Configuración](08-configuracion.md) | `ShopifyCredentials:LeadPrefix` y `DefaultPriceListId` |
