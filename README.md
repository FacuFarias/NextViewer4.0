# NextViewer 5.0 Clinical

Visor web DICOM de consulta clínica basado en React, Cornerstone3D y DICOMweb.
Esta rama deriva de NextViewer 4.0, pero no contiene flujos de entrenamiento de
IA, segmentación, persistencia de anotaciones ni un servicio propio de informes.

> Uso previsto: consulta y revisión clínica. No está validado como estación de
> diagnóstico primario.

## Alcance

- Acceso del personal mediante Keycloak OIDC Authorization Code + PKCE.
- Enlaces restringidos para pacientes mediante `share_token` de NextRIS.
- CT, MR, CR, DX, MG, US, XA, RF, NM, PT, SC y OT.
- Stack, multiframe y MPR para CT/MR con geometría válida.
- Window/level, pan, zoom, scroll, inversión, longitud, ángulo, bidireccional,
  ROI circular/rectangular y flecha.
- Mediciones y caché de imágenes únicamente en memoria durante la sesión.
- Hanging protocols globales por modalidad y protocolos personales persistidos
  en NextRIS para el personal autenticado.

Quedan fuera de esta versión DICOM SR, SEG, PDF encapsulado, video, informes y
comparación simultánea de múltiples estudios.

## Rutas

- `/viewer?StudyInstanceUIDs=<UID>`: contrato compatible con NextRIS.
- `/viewer?StudyInstanceUIDs=<UID>&share_token=<token>`: enlace para paciente.
- `/viewer/<UID>`: ruta interna alternativa.
- `/callback`: retorno OIDC.
- `/set-token.html?handoff_code=<CODE>&study_uid=<UID>`: handoff opaco de un
  solo uso y 60 segundos. El código se intercambia por sesiones DICOM y
  NextViewer, que permanecen únicamente en `sessionStorage`.
- `/set-token.html?access_token=<JWT>&study_uid=<UID>`: compatibilidad temporal
  con el puente legado; sus parámetros también se eliminan de inmediato.
- `/healthz`: healthcheck del contenedor.

Se acepta exactamente un Study Instance UID por enlace. La raíz no muestra ni
consulta el listado general de pacientes.

## Desarrollo y validación

```bash
cd dicom-viewer
npm ci
npm test
npm run lint
npm run build
```

La configuración de producción se genera al iniciar el contenedor desde las
variables documentadas en `dicom-viewer/.env.example`; ninguna credencial se
compila en el frontend.

Las pruebas incluyen fixtures sintéticos y anónimos de metadata para CR, RF,
NM, PT, SC, multiframe, JPEG Lossless, JPEG-LS, JPEG 2000 y RLE. No contienen
datos de pacientes ni sustituyen la prueba visual de decodificación con DICOM
anonimizados aprobados para validación clínica.

## Hanging protocols

Los defaults versionados son CT/MR con MPR y fallback stack, CR/DX frontal y
lateral, MG RCC–LCC / RMLO–LMLO, y `1×1` para las modalidades restantes. El
editor se abre desde `Herramientas → Hanging protocols` como panel superpuesto
desde la izquierda. Los protocolos personales guardan sólo layout y reglas de
matching; no guardan window/level, cámara, inversión, mediciones ni herramienta
activa.

NextRIS expone bajo `/api/viewer/` el intercambio y renovación de sesión y el
CRUD de protocolos. La migración requerida es
`deployment/migrations/20260816_hanging_protocols.sql`. Las credenciales
técnicas se configuran mediante `VIEWER_KEYCLOAK_*`; no están embebidas en el
frontend ni en el backend.

## Despliegue y rollback

El servicio Compose `nextviewer5-clinical` escucha solamente en
`127.0.0.1:30001`. El proxy HTTPS público `clinicacp.ddns.net:3000` apunta a ese
puerto. El visor anterior permanece ejecutándose en `127.0.0.1:30000`.

Rollback inmediato:

1. Establecer `VIEWER_HANDOFF_MODE=legacy` en el `.env` de NextRIS y reiniciar
   `nextris-backend.service`.
2. Cambiar en `/etc/nginx/sites-enabled/clinicacp` el upstream del bloque que
   escucha en `3000` de `127.0.0.1:30001` a `127.0.0.1:30000`.
3. Ejecutar `sudo nginx -t && sudo systemctl reload nginx`.

En este despliegue también quedó una copia previa exacta en
`/etc/nginx/sites-available/clinicacp.pre-nextviewer5`.

El rollback no requiere detener ni reconstruir ninguno de los dos visores.
