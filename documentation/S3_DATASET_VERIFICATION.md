# Verificación del dataset S3

Verificación realizada desde el servidor el 7 de agosto de 2026.

## Acceso disponible

- Bucket: `qii-images-for-training`
- Región: `us-east-2`
- Prefijo existente: `Anonimizied/` (esta es la ortografía real de la clave)
- Identidad de la instancia: rol asumido `QII-S3-ReadOnly`
- Operaciones comprobadas: listar prefijos y leer objetos
- Operaciones no comprobadas/autorizadas: escritura de resultados y lectura de la
  configuración de versionado, cifrado o ubicación del bucket

El acceso de lectura al dataset fuente no es suficiente para el pipeline completo.
Antes de habilitar workers, `report-service` necesita permiso `PutObject` sobre un
prefijo o bucket de salida independiente para los DICOM SEG. No deben entregarse
credenciales AWS permanentes al worker; las transferencias se realizan mediante URLs
prefirmadas por el backend.

## Revisión de desidentificación

Se inspeccionaron tres CT pertenecientes a tres carpetas `OP-*` distintas. En las
muestras, `PatientName` y `PatientID` estaban seudonimizados y los campos directos
de fecha de nacimiento, dirección, teléfono, institución y nombres de profesionales
estaban vacíos.

La revisión no constituye una certificación de anonimización DICOM completa:

- las muestras todavía contienen cinco tags privados;
- `PatientIdentityRemoved` no está informado;
- `DeidentificationMethod` no está informado.

Antes de usar el dataset fuera del entorno controlado conviene eliminar o revisar los
tags privados y registrar explícitamente el método/perfil de desidentificación aplicado.
