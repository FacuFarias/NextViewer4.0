# Anotaciones DICOM, visor y preparación para entrenamiento de IA

## 1. Propósito

Este documento describe la implementación actual de anotaciones y mediciones en el visor DICOM, su persistencia en el `report-service`, la restauración visual en Cornerstone y la forma recomendada de utilizar los datos para entrenamiento o validación de modelos de inteligencia artificial.

La solución permite:

- Crear mediciones sobre imágenes DICOM.
- Crear polígonos anatómicos mediante la sección **Polígonos**.
- Guardar cada anotación asociada a los UIDs DICOM originales.
- Recuperar las anotaciones al recargar el estudio.
- Navegar a la imagen exacta donde fue creada una medición.
- Mostrar el tipo, color, etiqueta anatómica y estado de guardado.
- Eliminar anotaciones mediante soft delete.
- Mantener historial y versiones.
- Diferenciar anotaciones humanas, generadas por IA y corregidas por un humano.
- Utilizar la geometría persistida como base para datasets de IA.

La persistencia de las anotaciones es independiente de la tabla existente de reportes en `measurements.reports`.

## 2. Arquitectura general

```text
Usuario
  |
  v
Visor React + Cornerstone
  |  annotationService
  |  geometría Cornerstone -> coordenadas DICOM
  v
/report-api/                 proxy Nginx
  |
  v
report-service               API Express/TypeScript
  |
  v
PostgreSQL, schema ia
```

Componentes principales del frontend:

- `dicom-viewer/src/hooks/useDicomViewer.ts`: orquesta viewport, stack, caché, restauración y persistencia.
- `dicom-viewer/src/services/annotations.ts`: repositorio HTTP de anotaciones.
- `dicom-viewer/src/services/annotationGeometry.ts`: conversión entre Cornerstone y coordenadas persistibles.
- `dicom-viewer/src/services/nasalSeptumDeviation.ts`: cálculo físico de la medición lineal del tabique.
- `dicom-viewer/src/tools/NasalSeptumDeviationTool.ts`: herramienta Cornerstone de tres clics.
- `dicom-viewer/src/services/ctSinusesMeasurements.ts`: ontología y configuración de Features anatómicas.
- `dicom-viewer/src/components/MeasurementsPanel.tsx`: lista, guarda, restaura y elimina mediciones desde la interfaz.
- `dicom-viewer/src/components/CtSinusesFeaturePanel.tsx`: selector de regiones anatómicas.
- `dicom-viewer/src/components/LinesPanel.tsx`: selector de mediciones lineales.
- `dicom-viewer/src/components/ConfirmDialog.tsx`: confirmaciones visuales propias del sistema.

Componentes principales del backend:

- `report-service/src/routes/annotations.ts`: endpoints y validación de payloads.
- `report-service/src/repositories/annotationRepository.ts`: operaciones PostgreSQL, versionado, historial y bulk.
- `report-service/src/migrations/annotations.ts`: migración idempotente del schema `ia`.
- `report-service/src/auth.ts`: autenticación y permisos preparados para Keycloak.

El acceso externo continúa siendo `/report-api/`. Internamente, Nginx lo reenvía a las rutas `/api/` del `report-service`.

## 3. Qué se puede anotar

### 3.1 Herramientas estándar

El visor conserva las herramientas actuales de Cornerstone:

| Herramienta visible | `geometryType` persistido |
| --- | --- |
| Distancia | `polyline` |
| Flecha | `arrow` |
| ROI circular | `circle` |
| Ángulo | `angle` |
| Bidireccional | `bidirectional` |
| Rectángulo | `rectangle` |

### 3.2 Features anatómicas

Las Features son polígonos anatómicos y se persisten como `polygon`. La ontología inicial es `v1` e incluye:

- Nasal Cavity (`nasal-cavity`)
- Septum (`septum`)
- Bone Spur (`bone-spur`)
- Inferior Turbinates (`inferior-turbinates`)
- Middle Turbinates (`middle-turbinates`)
- Superior Turbinates (`superior-turbinates`)
- Concha Bullosa (`concha-bullosa`)
- Middle Meatus (`middle-meatus`)
- Orbits (`orbits`)
- Maxillary Sinus (`maxillary-sinus`)
- Sphenoid Sinus (`sphenoid-sinus`)
- Frontal Sinus (`frontal-sinus`)
- Ethmoid Cells (`ethmoid-cells`)
- Osteomeatal Complex (`osteomeatal-complex`)
- Hard Palate (`hard-palate`)
- Soft Palate (`soft-palate`)
- Nasopharynx (`nasopharynx`)
- Oral Cavity (`oral-cavity`)
- Cranial Cavity (`cranial-cavity`)

Cada región tiene un código estable, nombre, color y `segmentIndex`. El código no debe reemplazarse por el texto traducido o visible en la interfaz.

Ejemplo de definición ontológica:

```json
{
  "code": "nasal-cavity",
  "name": "Nasal Cavity",
  "color": "#1976d2",
  "segmentIndex": 1
}
```

La sección **Features** es colapsable y comienza cerrada para dejar más espacio al viewport.

## 4. Modelo de datos

La migración `002_annotations` crea las tablas en el schema `ia`.

### 4.1 `ia.annotation_set`

Representa un conjunto de anotaciones asociado a un estudio.

Campos relevantes:

- `id`: identificador del conjunto.
- `study_instance_uid`: estudio DICOM.
- `name` y `description`.
- `ontology_version`: actualmente `v1`.
- `status`: normalmente `draft`.
- `is_default`: permite identificar el conjunto automático del estudio.
- `created_by`, `created_at`, `updated_at`.

Al abrir un estudio, el visor busca el conjunto draft por su `StudyInstanceUID`. Si no existe, crea automáticamente uno con un nombre como `Anotaciones <StudyInstanceUID>`.

### 4.2 `ia.annotation`

Una fila representa una anotación o una versión de una anotación.

Identificación DICOM:

- `study_instance_uid`.
- `series_instance_uid`.
- `sop_instance_uid`.
- `frame_number`, si aplica.
- `instance_number`, como dato auxiliar de orden y visualización.

Identificación semántica y visual:

- `label_code`.
- `label_name`.
- `tool_name`.
- `color`.
- `geometry_type`.
- `geometry` en JSONB.

Proveniencia y revisión:

- `source`: `HUMAN`, `AI` o `AI_CORRECTED`.
- `status`: `draft`, `reviewed`, `approved`, `rejected` o `archived`.
- `model_run_id` y `confidence`, para resultados de IA.
- `created_by` y `reviewed_by`.

Versionado:

- `version`.
- `supersedes_annotation_id`.
- `created_at`, `updated_at` y `deleted_at`.

Datos DICOM no identificatorios:

- modalidad;
- filas y columnas;
- pixel spacing;
- image position/orientation;
- frame of reference UID;
- series number.

También se guarda `cornerstone_annotation_uid` para vincular el registro persistido con la anotación visual del viewport y `client_mutation_id` para operaciones idempotentes.

### 4.3 `ia.model_run`

Permite registrar el contexto de una ejecución de IA. Puede contener:

- nombre y versión del modelo;
- hash de los pesos;
- parámetros de inferencia;
- fecha de ejecución;
- usuario o proceso que ejecutó el modelo.

Las anotaciones producidas por el modelo deben referenciar este registro mediante `model_run_id`.

### 4.4 Idempotencia bulk

`ia.annotation_bulk_mutation` registra mutaciones bulk procesadas. Si el cliente reintenta una solicitud con el mismo `clientMutationId`, el backend puede devolver el resultado existente sin duplicar anotaciones.

### 4.5 Diferencia entre estudio, conjunto y procedencia

Es importante no confundir `study_instance_uid` con `annotation_set` ni con `source`.

`study_instance_uid` identifica el estudio DICOM. Por sí solo permite buscar todas las anotaciones que apuntan a ese estudio.

`annotation_set` no representa otra imagen ni otra copia del estudio. Es un contenedor lógico o espacio de trabajo que permite agrupar anotaciones bajo un mismo contexto. En la implementación actual el visor crea o reutiliza normalmente un único conjunto `draft` por estudio, con un nombre como `Anotaciones <StudyInstanceUID>`. Por lo tanto:

- actualmente no separa las anotaciones por usuario;
- dos usuarios pueden trabajar sobre el mismo conjunto si abren el mismo estudio;
- `created_by` registra el autor, pero no funciona todavía como filtro de propiedad o visibilidad;
- si solo se necesitara consultar anotaciones por estudio, el `study_instance_uid` sería suficiente.

El valor de `annotation_set` aparece cuando se necesitan varios contextos para el mismo estudio, por ejemplo, distintas rondas de trabajo o diferentes versiones de un dataset.

La diferencia entre los campos es:

| Campo | Pregunta que responde |
| --- | --- |
| `study_instance_uid` | ¿A qué estudio DICOM pertenece? |
| `annotation_set_id` | ¿A qué colección, ronda o espacio de trabajo pertenece? |
| `source` | ¿Quién o qué generó esta anotación? |
| `model_run_id` | ¿Qué modelo y ejecución de IA la produjeron? |
| `status` | ¿Cuál es el estado de revisión de esta anotación? |
| `created_by` | ¿Qué usuario quedó registrado como creador? |

Por ejemplo, `source = AI` indica que una anotación individual fue generada por inteligencia artificial, pero no indica por sí solo si pertenece al conjunto de predicciones iniciales, a una revisión humana o al dataset final aprobado.

### 4.6 Casos de uso de múltiples conjuntos

En una evolución del sistema, un mismo estudio podría tener colecciones como:

```text
Estudio DICOM
├── Predicción modelo v1
│   └── anotaciones source=AI
├── Revisión humana
│   └── anotaciones source=HUMAN y AI_CORRECTED
├── Segunda opinión
│   └── anotaciones de otro revisor
└── Dataset aprobado
    └── anotaciones seleccionadas para entrenamiento
```

Otros ejemplos son:

- separar anotaciones de distintos modelos o versiones de pesos;
- conservar una ronda inicial y una ronda de corrección sin mezclarlas;
- distinguir una anotación clínica operativa de una etiqueta preparada para investigación;
- crear un conjunto de validación independiente;
- mantener una segunda opinión sin sobrescribir la primera;
- aplicar una versión diferente de la ontología anatómica;
- aprobar o archivar una colección completa mediante su estado.

En el caso de una corrección humana sobre IA, la relación recomendada es:

```text
anotación source=AI, versión 1
             |
             v
anotación source=AI_CORRECTED, versión 2
```

El versionado conserva ambas filas mediante `supersedes_annotation_id`, mientras que el `annotation_set` permite mantenerlas dentro de la misma ronda o moverlas conceptualmente a una colección de revisión, según la política que se implemente.

Si el sistema solo necesita distinguir `HUMAN`, `AI` y `AI_CORRECTED`, registrar el modelo y consultar por estudio, el conjunto aporta poca funcionalidad adicional. Si se necesitan rondas, datasets, aprobaciones o contextos paralelos, el conjunto evita mezclar anotaciones que tienen distinta finalidad.

El modelo actual conserva `annotation_set` como preparación para esos flujos, aunque todavía no implementa conjuntos privados por usuario. Para separar realmente por usuario habría que agregar un propietario o usuario responsable al conjunto, filtrar por el usuario autenticado y definir una regla de unicidad como `study_instance_uid + owner_user_id`.

## 5. Geometría y sistema de coordenadas

La geometría persistida utiliza siempre el sistema:

```json
{
  "coordinateSystem": "IMAGE_PIXEL"
}
```

No se guardan coordenadas CSS, coordenadas de pantalla ni coordenadas dependientes del tamaño visual del canvas.

### 5.1 Conversión

El flujo es:

```text
handles/contour de Cornerstone
  -> world mediante el viewport activo
  -> imageData.worldToIndex
  -> coordenadas de pixel de la imagen DICOM
  -> geometry JSONB
```

Para reconstruir una anotación se ejecuta la conversión inversa:

```text
geometry.points en IMAGE_PIXEL
  -> imageData.indexToWorld
  -> puntos World
  -> handles/contour de Cornerstone
  -> viewport.render()
```

Las transformaciones respetan zoom, paneo, rotación, flip y resize porque utilizan las APIs oficiales del viewport, no cálculos manuales sobre el DOM.

### 5.2 Estructura de `geometry`

```json
{
  "coordinateSystem": "IMAGE_PIXEL",
  "imageWidth": 400,
  "imageHeight": 400,
  "points": [
    { "x": 205.13, "y": 74.88 },
    { "x": 248.42, "y": 91.17 },
    { "x": 236.03, "y": 151.62 }
  ],
  "patientPoints": [
    { "x": -21.3, "y": 44.7, "z": -116.2 },
    { "x": -19.2, "y": 45.1, "z": -116.2 }
  ],
  "shape": {
    "closed": true,
    "segmentIndex": 1,
    "cachedStats": {}
  }
}
```

`patientPoints` es opcional. Se conserva para exportaciones y usos espaciales posteriores. Las mediciones editables se realizan y persisten únicamente sobre el Stack DICOM nativo; las reconstrucciones MPR actuales son de solo lectura y sirven para orientación.

Los puntos se almacenan como decimales sin redondear. Para evitar payloads excesivamente grandes, los contornos se compactan de forma uniforme hasta un máximo de 2048 puntos persistidos y no se duplican innecesariamente dentro de `shape`.

### 5.3 Validaciones geométricas

El backend verifica que:

- `coordinateSystem` sea `IMAGE_PIXEL`;
- ancho y alto sean finitos y positivos;
- todos los puntos tengan coordenadas finitas;
- el JSON de geometría tenga una estructura válida.

Para polígonos anatómicos, el frontend exige además un contorno cerrado con al menos tres puntos antes de permitir el guardado.

## 6. Flujo de trabajo en el visor

### 6.1 Apertura de estudio y serie

1. Se obtiene el estudio y la lista de series.
2. Al seleccionar una serie se construye el stack de imágenes.
3. Se inicia la precarga de todas las imágenes de la serie con concurrencia controlada.
4. La tarjeta de la serie muestra el porcentaje cargado en caché.
5. Se obtiene o crea el `annotation_set` draft del estudio.
6. Se solicitan las anotaciones persistidas de la serie.
7. Se reconstruyen en el viewport las anotaciones correspondientes a cada imagen.

La restauración se basa principalmente en `SOPInstanceUID`; `InstanceNumber` se conserva como apoyo visual y ordenamiento, pero no es la identidad principal de una imagen.

### 6.2 Crear y guardar

Al crear o modificar una medición, el visor la mantiene en estado local y la muestra en el panel **Mediciones**.

Cada tarjeta muestra:

- tipo de herramienta o nombre anatómico;
- color;
- imagen e instancia;
- valor calculado, si existe;
- estado de persistencia.

### 6.3 Política de MPR

El modo MPR muestra dos tipos de viewport claramente diferenciados:

- **DICOM NATIVO**: contiene la serie original almacenada en el PACS. Es el viewport principal, editable y único destino para crear polígonos, líneas y mediciones.
- **MPR · RECONSTRUCCIONES**: contiene vistas axial, sagital y coronal reconstruidas a partir de la serie seleccionada. Se utilizan para ubicarse espacialmente, mover el crosshair, hacer paneo, zoom y scroll; no crean ni restauran anotaciones.

El usuario debe seleccionar la serie nativa correspondiente para medir un plano determinado. Si selecciona una medición desde MPR, el visor vuelve automáticamente al Stack, cambia de serie si hace falta y navega por `SOPInstanceUID`.

Esta política evita asociar una geometría de pantalla reconstruida a una imagen DICOM que no existe como instancia almacenada. Las anotaciones MPR históricas no se utilizan para las nuevas restauraciones; las mediciones se deben redibujar sobre la serie nativa.

El botón con ícono de disco permite guardar explícitamente. Después de guardar correctamente aparece un check verde. También existe guardado automático con debounce para no enviar una anotación incompleta durante el dibujo.

Estados principales:

- `saving`: operación en curso;
- `saved`: existe una versión persistida;
- `error`: falló el guardado y se muestra la opción de reintentar.

El panel no elimina una medición si falla una operación de red. La anotación queda visible y pendiente para que el usuario pueda reintentar.

### 6.3 Seleccionar una medición guardada

Al hacer click en una tarjeta:

1. Se identifica el `SOPInstanceUID` guardado.
2. Se busca esa instancia dentro del stack de la serie.
3. El viewport navega a esa imagen.
4. Si existe `frameNumber`, se utiliza el frame correspondiente.
5. Se selecciona o restaura la anotación.
6. Se fuerza el render del viewport.

### 6.4 Eliminar

El botón de eliminar solicita confirmación mediante un diálogo propio del visor, no mediante un `alert` o `confirm` nativo de Chrome.

Al confirmar:

1. Se ejecuta un `DELETE` lógico en el backend.
2. Se marca `deleted_at` sin destruir el registro histórico.
3. Se retira la anotación del viewport.
4. Se actualiza el panel de mediciones.

El aviso de pestaña o recarga del navegador puede seguir utilizando el mecanismo nativo `beforeunload`, porque los navegadores no permiten reemplazar completamente ese aviso en el cierre de la pestaña.

## 7. Restauración visual en Cornerstone

La restauración utiliza el `toolName` persistido y convierte los puntos pixel nuevamente a World. Para cada registro se reconstruyen:

- `annotationUID`;
- metadata de herramienta, color, imagen referenciada y `annotationId`;
- handles de las herramientas estándar;
- polyline y estado `closed` de polígonos;
- datos de segmentación y `segmentIndex` para Features anatómicas;
- `FrameOfReferenceUID` cuando está disponible.

Después de agregar la anotación al estado de Cornerstone se ejecuta `viewport.render()` para garantizar que el gráfico sea visible inmediatamente.

Los registros históricos creados antes de que se persistieran correctamente `toolName`, `color` y todos los puntos pueden aparecer como polígonos genéricos. Si el registro antiguo contiene solamente un punto, no es posible recuperar geométricamente el contorno original; en ese caso debe volver a dibujarse y guardarse.

## 8. API pública de anotaciones

La API externa se consume bajo `/report-api/`.

### Annotation sets

```text
POST   /report-api/annotation-sets
GET    /report-api/annotation-sets/:id
GET    /report-api/studies/:studyInstanceUID/annotation-sets
PATCH  /report-api/annotation-sets/:id
```

### Annotations

```text
POST   /report-api/annotations
GET    /report-api/annotations
GET    /report-api/annotations/:id
PATCH  /report-api/annotations/:id
DELETE /report-api/annotations/:id
GET    /report-api/annotations/:id/history
POST   /report-api/annotations/bulk
```

Filtros disponibles para el listado:

- `studyInstanceUID`;
- `seriesInstanceUID`;
- `sopInstanceUID`;
- `frameNumber`;
- `annotationSetId`;
- `labelCode`;
- `source`;
- `status`;
- `latestOnly`;
- `limit` y `offset`.

Ejemplo de payload de creación:

```json
{
  "annotationSetId": "set-id",
  "studyInstanceUID": "1.2.3.study",
  "seriesInstanceUID": "1.2.3.series",
  "sopInstanceUID": "1.2.3.image",
  "instanceNumber": 148,
  "labelCode": "orbits",
  "labelName": "Orbits",
  "toolName": "PlanarFreehandContourSegmentationTool",
  "color": "#b4ba16",
  "geometryType": "polygon",
  "geometry": {
    "coordinateSystem": "IMAGE_PIXEL",
    "imageWidth": 400,
    "imageHeight": 400,
    "points": [
      { "x": 205.13, "y": 74.88 },
      { "x": 248.42, "y": 91.17 },
      { "x": 236.03, "y": 151.62 }
    ],
    "shape": { "closed": true, "segmentIndex": 9 }
  },
  "source": "HUMAN",
  "status": "draft",
  "clientMutationId": "browser-session-mutation-id"
}
```

Las solicitudes autenticadas propagan el Bearer token existente. El backend no devuelve `PatientName` ni otros datos personales que no sean necesarios para identificar la imagen anotada.

## 9. Versionado, historial y concurrencia

Las anotaciones draft pueden actualizarse directamente cuando no existe conflicto.

Para anotaciones aprobadas o versionadas, una modificación genera una nueva fila:

```text
versión 1  ->  versión 2  ->  versión 3
                 |
                 +-- supersedes_annotation_id
```

La versión anterior no se pierde. La nueva fila incrementa `version` y referencia el registro reemplazado mediante `supersedes_annotation_id`.

El frontend envía la versión esperada o `updated_at`. Si otro usuario modificó el registro, el backend responde `409 Conflict` y el visor evita sobrescribir silenciosamente los datos.

`GET /report-api/annotations/:id/history` devuelve la cadena histórica de versiones.

## 10. Operaciones bulk y modo offline básico

`POST /report-api/annotations/bulk` procesa varias anotaciones dentro de una transacción PostgreSQL. La operación es idempotente cuando se envía `clientMutationId`.

El visor mantiene una cola en memoria durante la sesión:

- una anotación con error no desaparece;
- el panel muestra el error;
- el usuario puede reintentar;
- el sistema avisa si se intenta cambiar de estudio o salir con cambios pendientes.

La cola no utiliza IndexedDB en esta etapa. Por lo tanto, un cierre completo del navegador antes de completar el guardado puede perder cambios aún no confirmados por el backend.

## 11. Seguridad y permisos

El `report-service` soporta autenticación JWT preparada para Keycloak.

Reglas principales:

- `created_by` se obtiene del usuario autenticado;
- crear y editar requiere permisos de anotación;
- eliminar requiere permisos de escritura;
- revisar o aprobar requiere permisos de revisión;
- leer anotaciones requiere permiso de lectura;
- `AUTH_REQUIRED=true` debe utilizarse en despliegues protegidos;
- el modo local sin usuario solo debe habilitarse explícitamente para compatibilidad.

El acceso a imágenes DICOM y el acceso a anotaciones deben tratarse como datos clínicos. Aunque las respuestas de anotaciones no incluyen el nombre del paciente, los UIDs y las imágenes pueden seguir siendo sensibles. Cualquier exportación para entrenamiento debe aplicar autorización y desidentificación según la política del entorno.

## 12. Uso de las anotaciones para IA

### 12.1 Proveniencia

El campo `source` distingue tres casos:

| Valor | Uso |
| --- | --- |
| `HUMAN` | Anotación creada por un usuario. |
| `AI` | Anotación generada por un modelo. |
| `AI_CORRECTED` | Resultado de IA revisado y modificado por un humano. |

La confianza del modelo se guarda en `confidence` y el contexto de ejecución en `model_run_id`.

Una corrección humana sobre un resultado de IA debe conservar la trazabilidad y cambiar el origen a `AI_CORRECTED`, en lugar de borrar el resultado original.

### 12.2 Qué registros seleccionar

Para construir un dataset supervisado, la selección recomendada es:

1. Usar `status = 'approved'` como conjunto principal.
2. Incluir `source IN ('HUMAN', 'AI_CORRECTED')` para etiquetas validadas por personas.
3. Usar `latestOnly = true` y respetar la relación `supersedes_annotation_id`.
4. Excluir registros con `deleted_at IS NOT NULL` o estado `archived`.
5. Excluir geometrías incompletas, por ejemplo polígonos abiertos o con menos de tres puntos.
6. Validar que cada anotación apunte a un `SOPInstanceUID` existente.
7. Validar que los puntos estén dentro de `imageWidth` y `imageHeight`, permitiendo únicamente una tolerancia definida por el pipeline.
8. Agrupar por estudio y paciente antes de dividir el dataset.

Nunca se debe hacer una división aleatoria por imagen si varias imágenes pertenecen al mismo paciente o estudio. El split recomendado es por paciente o, como mínimo, por estudio, para evitar fuga de información entre entrenamiento y validación.

### 12.3 Conversión a máscaras y formatos de entrenamiento

La geometría `IMAGE_PIXEL` permite convertir polígonos a máscaras rasterizadas. Para un dataset de segmentación, el pipeline debe:

1. Resolver la imagen mediante `studyInstanceUID`, `seriesInstanceUID` y `sopInstanceUID`.
2. Leer `imageWidth` y `imageHeight` desde la anotación o del objeto DICOM validado.
3. Rasterizar `geometry.points` respetando el orden del contorno.
4. Asociar la máscara al `labelCode` de la ontología `v1`.
5. Conservar en el manifiesto la versión de ontología y la proveniencia.

Los puntos `patientPoints` pueden utilizarse posteriormente para tareas 3D, MPR o exportaciones espaciales. En esta etapa no se implementan exportadores DICOM SEG, NIfTI o COCO, pero la estructura persistida conserva la metadata necesaria para agregarlos.

### 12.4 Manifiesto recomendado

```json
{
  "datasetVersion": "2026-01",
  "ontologyVersion": "v1",
  "split": "train",
  "studyInstanceUID": "1.2.3.study",
  "seriesInstanceUID": "1.2.3.series",
  "sopInstanceUID": "1.2.3.image",
  "frameNumber": null,
  "imageWidth": 400,
  "imageHeight": 400,
  "modality": "CT",
  "annotationId": "annotation-id",
  "annotationVersion": 2,
  "labelCode": "orbits",
  "labelName": "Orbits",
  "source": "AI_CORRECTED",
  "status": "approved",
  "points": [
    { "x": 205.13, "y": 74.88 },
    { "x": 248.42, "y": 91.17 },
    { "x": 236.03, "y": 151.62 }
  ],
  "modelRunId": null,
  "confidence": null
}
```

El manifiesto debe acompañarse con una referencia segura al archivo de imagen desidentificado. No se recomienda colocar imágenes clínicas dentro de la misma exportación sin aplicar antes el proceso de desidentificación aprobado.

### 12.5 Flujo de inferencia y corrección

```text
Imagen DICOM autorizada
  -> modelo IA
  -> annotation con source=AI
  -> revisión humana
  -> aprobación o corrección
  -> source=AI_CORRECTED
  -> dataset validado
```

Para reproducibilidad, cada ejecución debe registrar el modelo, versión, hash de pesos y parámetros en `model_run`. La confianza del modelo no reemplaza la revisión humana cuando el dataset se utiliza como ground truth.

## 13. Control de calidad del dataset

Antes de entrenar, conviene ejecutar validaciones automáticas para:

- comprobar que todos los UIDs resuelvan a imágenes existentes;
- comprobar dimensiones y modalidad;
- verificar puntos finitos y dentro de límites;
- verificar que los polígonos anatómicos estén cerrados;
- detectar duplicados por UID, label y versión vigente;
- detectar etiquetas fuera de la ontología activa;
- detectar colores que no correspondan a la ontología;
- medir cantidad de muestras por clase;
- identificar estudios con anotaciones contradictorias;
- separar datos con `source=AI` no revisados de los datos de referencia;
- mantener un registro de quién aprobó cada anotación.

El desequilibrio entre clases debe medirse antes del entrenamiento. Si una región aparece pocas veces, puede ser necesario ampliar la muestra, aplicar estrategias de balanceo o reportar métricas por clase, sin fabricar etiquetas sintéticas sin trazabilidad.

## 14. Despliegue y verificación

El despliegue utiliza:

- `nextviewer4/dicom-viewer` para el visor;
- `nextviewer4/report-service` para la API;
- PostgreSQL para metadatos y anotaciones;
- Nginx como proxy `/report-api/`.

La migración de anotaciones es idempotente: puede ejecutarse sobre una base limpia o repetirse sin duplicar tablas, índices ni triggers.

Verificaciones mínimas después de desplegar:

```bash
curl http://localhost:3701/health
curl http://localhost:3000/
```

También debe comprobarse:

- que el visor cargue el bundle actualizado;
- que `/report-api/` alcance el `report-service`;
- que una creación de anotación responda sin `413 Payload Too Large`;
- que el guardado muestre el check verde;
- que la recarga reconstruya el gráfico y conserve tipo, color y etiqueta;
- que el soft delete retire la anotación sin eliminar su historial.

El proxy y Express admiten payloads de hasta 25 MB. La compactación de contornos evita enviar puntos duplicados y reduce el tamaño habitual de las solicitudes.

## 15. Limitaciones actuales y evolución prevista

- La cola offline es solamente en memoria; todavía no hay IndexedDB.
- El modo MPR es actualmente de orientación: sus reconstrucciones no son editables y no persisten anotaciones. La edición debe realizarse sobre el Stack DICOM nativo.
- Los exportadores DICOM SEG, NIfTI y COCO todavía no están implementados.
- La ontología inicial de Features es la de senos paranasales y está versionada como `v1`.
- La resolución visual depende de que la geometría histórica tenga suficientes puntos y un `toolName` válido.
- Los registros heredados incompletos deben revisarse o redibujarse.

La interfaz interna prevista para exportación es:

```text
AnnotationGeometryExporter
├── DICOM SEG
├── NIfTI
└── COCO
```

Esta separación permite generar formatos de entrenamiento sin acoplar el almacenamiento de anotaciones a un único framework de IA.

## 16. Medición lineal Nasal Septum Deviation

El visor incluye una herramienta semántica para medir la desviación del tabique nasal en el Stack CT. La sección visible como **Polígonos** conserva las Features anatómicas; debajo, **Lines** contiene **Nasal Septum Deviation**.

La herramienta requiere tres clics:

1. `axis_start`, inicio del eje del tabique.
2. `axis_end`, fin del eje.
3. `deviation_point`, punto de máxima desviación.

El cuarto punto, `projection_point`, se calcula automáticamente como la proyección perpendicular del tercer punto sobre la recta definida por los dos primeros. La anotación dibuja el eje y la línea perpendicular, sin relleno poligonal. Sus cuatro puntos se conservan en `points[0..3]`.

Las distancias se calculan en milímetros usando `PixelSpacing` DICOM. Como DICOM define el espaciado como `[rowSpacing, columnSpacing]`, el eje X usa el segundo valor y el eje Y el primero. La proyección se calcula sobre la recta infinita, por lo que mantiene los 90 grados incluso si cae fuera del segmento visual entre los dos puntos del eje.

El registro se guarda como una única fila de `ia.annotation` con:

- `geometryType` y `labelCode`: `nasal_septum_deviation`;
- `toolName`: `NasalSeptumDeviationTool`;
- color: `#ff6f00`;
- `sopInstanceUID` de la imagen exacta;
- geometría `IMAGE_PIXEL` con los cuatro puntos;
- `axis_length_mm`, `deviation_length_mm` y `pixel_spacing` dentro de `geometry.shape`.

La imagen se identifica siempre por `SOPInstanceUID`; `InstanceNumber` solo se muestra como dato auxiliar. Al recargar o seleccionar una medición, el visor busca ese SOP, transforma los cuatro puntos nuevamente a World mediante Cornerstone y reconstruye la herramienta. Al mover los handles se recalcula la proyección, se actualizan ambas distancias y se guarda una nueva versión mediante el mecanismo de concurrencia existente.

No se permite guardar un eje de longitud cero, puntos no numéricos o imágenes sin Pixel Spacing válido. La herramienta está limitada al Stack CT nativo; las reconstrucciones MPR se muestran como referencia espacial y no son destinos de medición.

### 16.1 Panel de mediciones del estudio

El panel de mediciones consulta el `annotation_set` del estudio sin filtrar por `seriesInstanceUID`. Por eso puede mostrar anotaciones de todas las series del estudio, indicando la serie y la instancia de cada registro. Al seleccionar una medición de otra serie, el visor cambia de serie, localiza el `SOPInstanceUID` y navega a la imagen correspondiente antes de resaltar la anotación.

Al eliminar una medición, se ejecuta el soft delete en PostgreSQL y también se retira inmediatamente del estado de anotaciones de Cornerstone y del viewport visible. El registro histórico permanece disponible.
