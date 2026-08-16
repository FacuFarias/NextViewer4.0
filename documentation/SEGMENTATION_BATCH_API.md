# API batch de DICOM SEG

El orquestador obtiene un token con Keycloak Client Credentials y el rol
`segmentation-worker`. Todas las rutas usan `Authorization: Bearer <token>`.

## 1. Reclamar trabajo

```http
POST /report-api/worker/segmentation-jobs/claim
Content-Type: application/json

{
  "workerId": "gpu-worker-01",
  "batchSize": 5,
  "modelName": "minicat-3d",
  "modelVersion": "1"
}
```

Cada elemento devuelve `job`, `leaseToken`, `leaseExpiresAt` e `inputManifest`.
Los objetos del manifiesto incluyen SOP Instance UID, orden de instancia, S3 key y
`downloadUrl`. El token del lease no debe registrarse en logs.

## 2. Heartbeat y renovación

Enviar un heartbeat antes de que expire el lease; el valor recomendado es cada cinco
minutos. La etapa puede ser `downloading`, `processing` o `uploading`.

```http
POST /report-api/worker/segmentation-jobs/{jobId}/heartbeat
X-Segmentation-Lease-Token: <leaseToken>

{ "stage": "processing", "progress": 42 }
```

`GET /worker/segmentation-jobs/{jobId}/input-manifest` renueva las URLs S3 sin crear
otro intento y requiere el mismo header de lease.

## 3. Subir y completar

Calcular SHA-256 del archivo en Base64 y solicitar la URL de salida:

```http
POST /report-api/worker/segmentation-jobs/{jobId}/output-upload-url
X-Segmentation-Lease-Token: <leaseToken>

{ "checksumSha256": "<sha256-base64>" }
```

El worker debe hacer `PUT` a `url` enviando todos los `headers` recibidos. Después del
upload debe eliminar el directorio temporal del job y notificar:

```json
{
  "bucket": "dicom-segmentation",
  "key": "dicom-seg/1.2.3/4.5.6/job-id.dcm",
  "versionId": "optional-version-id",
  "etag": "optional-etag",
  "checksumSha256": "<sha256-base64>",
  "sizeBytes": 123456,
  "segmentationSeriesInstanceUID": "1.2.840...",
  "segmentationSOPInstanceUID": "1.2.840...",
  "frameOfReferenceUID": "1.2.840...",
  "dimensions": [512, 512, 240],
  "spacing": [0.5, 0.5, 0.8],
  "ontologyVersion": "minicat-sinus-v1",
  "name": "MINICAT SINUS · AI",
  "description": "Segmentación automática",
  "weightsHash": "sha256:...",
  "parameters": {}
}
```

Enviar ese cuerpo a `POST /worker/segmentation-jobs/{jobId}/complete` junto con el
header de lease. La operación es idempotente: puede repetirse con el mismo job/token si
la respuesta se pierde. El backend verifica S3, publica por STOW-RS, comprueba el SOP por
QIDO y recién entonces responde con `status: completed`.

## 4. Fallos y limpieza local

```http
POST /report-api/worker/segmentation-jobs/{jobId}/fail
X-Segmentation-Lease-Token: <leaseToken>

{
  "code": "MODEL_OUT_OF_MEMORY",
  "message": "El volumen excede la memoria disponible",
  "retryable": true
}
```

Cada job debe usar un directorio temporal propio. El worker lo elimina en un bloque
`finally`, tanto en éxito como en fallo. Solo debe reclamar el siguiente lote después de
terminar esa limpieza y persistir la metadata necesaria para reintentar `complete` sin el
archivo local, ya que el resultado ya se encuentra en S3.
