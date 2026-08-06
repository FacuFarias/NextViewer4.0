# NextViewer 4.0

Visor DICOM web profesional basado en Cornerstone.js 3D, diseñado para conectarse con servidores PACS dcm4chee via DICOMweb.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![React](https://img.shields.io/badge/React-18-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)
![Cornerstone.js](https://img.shields.io/badge/Cornerstone.js-3D-green.svg)

## Características

### Visualización
- Visualización de imágenes DICOM de alta resolución
- Windowing interactivo (brillo/contraste) con presets por modalidad
- Navegación por series con filmstrip de miniaturas
- DICOM overlay con información del paciente
- Soporte para múltiples modalidades (CT, MR, DX, US, MG, etc.)

### MPR (Multi-Planar Reconstruction)
- Visualización axial, sagital y coronal para estudios CT
- Doble click para maximizar/restaurar viewports
- Zoom estándar con rueda central, `Ctrl + rueda` y controles `- / + / 100%`
- Crosshair sincronizado entre planos
- Navegación por scroll con posición persistente e independiente en cada plano
- Checkbox para mostrar u ocultar los ejes de corte durante la edición

### Segmentación voxel 3D para MINICAT SINUS

La rama `feature/minicat-voxel-segmentation` incorpora un flujo experimental de segmentación volumétrica editable:

- Labelmap 3D único y compartido entre axial, sagital y coronal
- Ontología de 19 estructuras anatómicas con `segmentIndex`, nombre y color propios
- `Brush` para pintar y `Circle` para borrar voxels con tamaño ajustable entre 1 y 25
- `Grow` por intensidad HU, conectividad 6/18/26 y distancia máxima desde la semilla
- `Eraser` por crecimiento de región desde MPR y borrado de superficies desde la vista 3D
- Tolerancia HU inicial adaptada a la estructura anatómica activa
- Interpolación automática entre cortes marcados
- Undo/redo para Brush, Grow y Eraser
- Visibilidad y bloqueo independiente de cada segmento
- Reconstrucción de superficie 3D con orientación frontal inicial
- Cubo anatómico sincronizado con la cámara y accesos a vistas `ANT/POST/IZQ/DER/SUP/INF`
- El Grow se ejecuta exclusivamente desde MPR; la vista 3D permite inspección y Eraser
- Las anotaciones poligonales 2D existentes permanecen disponibles y separadas del Labelmap

#### Persistencia DICOM SEG

- El CT fuente no se modifica
- Cada guardado genera un objeto DICOM SEG independiente con los segmentos del Labelmap
- El objeto se publica en dcm4chee mediante DICOMweb STOW-RS
- PostgreSQL conserva metadatos, estado, autor, UIDs y relación entre versiones
- Las segmentaciones guardadas pueden listarse, abrirse, editarse y guardarse como una nueva versión
- La importación valida compatibilidad geométrica con el volumen CT fuente

#### Interfaz de segmentación

- Los controles voxel están agrupados en la barra derecha
- `Measurements` es colapsable y comienza cerrado
- La barra superior queda reservada para navegación, Window/Level, zoom y cambio MPR/3D
- El doble clic maximiza/restaura el viewport y no ejecuta accidentalmente Grow o Eraser

### Herramientas de Medición
- Medición de distancias
- Flechas de anotación
- ROI circular y rectangular
- Medición de ángulos
- Medición bidireccional

### Funcionalidades Adicionales
- Descarga de DICOM (serie individual o estudio completo) como ZIP
- Panel de reportes con guardado local
- Sidebar redimensionable
- Interfaz responsive (desktop, tablet, móvil)
- Configuración de features por administrador
- Autenticación via Keycloak (OAuth2)

## Requisitos

- Node.js 18+ o 20+
- Servidor dcm4chee Archive 5.x con DICOMweb habilitado
- Keycloak configurado para autenticación

## Instalación

### Desarrollo

```bash
# Clonar el repositorio
git clone https://github.com/FacuFarias/NextViewer4.0.git
cd NextViewer4.0/dicom-viewer

# Instalar dependencias
npm install

# Ejecutar en modo desarrollo
npm run dev
```

### Producción (Docker)

```bash
# Construir la imagen
docker build -t nextviewer4 .

# Ejecutar
docker run -p 3000:80 nextviewer4
```

### Despliegue paralelo estable y experimental

La imagen estable puede permanecer en `3000` mientras la rama de segmentación se ejecuta en `3001`. Los contenedores usan imágenes independientes; no es necesario duplicar ni reemplazar manualmente los archivos del visor estable.

```bash
# Desde la raíz del repositorio, sobre la rama experimental
git switch feature/minicat-voxel-segmentation
docker build -t nextviewer4-voxel:latest ./dicom-viewer

docker run -d \
  --name nextviewer4-voxel \
  --restart unless-stopped \
  --network opt_default \
  -p 3001:80 \
  nextviewer4-voxel:latest
```

Puertos usados en el servidor actual:

| Versión | Rama | Puerto |
|---------|------|--------|
| Estable | `main` | `3000` |
| Segmentación voxel | `feature/minicat-voxel-segmentation` | `3001` |

### Con docker-compose

```yaml
services:
  ohif:
    build: ./dicom-viewer
    container_name: nextviewer4
    ports:
      - "3000:80"
    environment:
      - TZ=America/Argentina/Buenos_Aires
    depends_on:
      - arc
      - keycloak
```

## Configuración

### Conexión a dcm4chee

Edita `src/services/dicomWeb.ts`:

```typescript
const DEFAULT_CONFIG: DicomWebConfig = {
  baseUrl: '/dcm4chee-arc/aets/DCM4CHEE/rs',
  wadoUrl: '/dcm4chee-arc/aets/DCM4CHEE/wado',
  username: 'admin',
  password: 'tu-password',
};
```

### Autenticación Keycloak

Edita `src/services/auth.ts`:

```typescript
const KEYCLOAK_URL = '/auth/realms/dcm4che/protocol/openid-connect/token';
const CLIENT_ID = 'dicom-viewer';
```

### Variables de Entorno

Crea un archivo `.env`:

```env
VITE_DCM4CHEE_BASE_URL=/dcm4chee-arc/aets/DCM4CHEE/rs
VITE_KEYCLOAK_URL=/auth/realms/dcm4che/protocol/openid-connect/token
```

## Estructura del Proyecto

```
dicom-viewer/
├── src/
│   ├── components/
│   │   ├── AdminRoute.tsx      # Guard de rutas admin
│   │   ├── ConfigPage.tsx      # Página de configuración
│   │   ├── DicomOverlay.tsx    # Overlay DICOM en viewport
│   │   ├── DicomViewer.tsx     # Componente principal
│   │   ├── DownloadButton.tsx  # Botón de descarga DICOM
│   │   ├── Filmstrip.tsx       # Barra de miniaturas
│   │   ├── Icons.tsx           # Iconos SVG
│   │   ├── MPRView.tsx         # Vista MPR 3 planos
│   │   ├── ReportPanel.tsx     # Panel de reportes
│   │   ├── ResizeHandle.tsx    # Handle para redimensionar
│   │   ├── SeriesPanel.tsx     # Panel de series
│   │   ├── StudyBrowser.tsx    # Lista de estudios
│   │   └── Toolbar.tsx         # Barra de herramientas
│   ├── hooks/
│   │   └── useDicomViewer.ts   # Hook principal del visor
│   ├── services/
│   │   ├── auth.ts             # Servicio de autenticación
│   │   ├── config.ts           # Servicio de configuración
│   │   ├── cornerstone.ts      # Configuración Cornerstone
│   │   ├── dicomWeb.ts         # Servicio DICOMweb
│   │   └── download.ts         # Servicio de descarga
│   ├── types/
│   │   ├── config.ts           # Tipos de configuración
│   │   └── dicom.ts            # Tipos DICOM
│   ├── App.tsx                 # Componente raíz con rutas
│   ├── App.css                 # Estilos principales
│   └── main.tsx                # Punto de entrada
├── Dockerfile                  # Configuración Docker
├── nginx.conf                  # Configuración Nginx
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Rutas

| Ruta | Descripción | Acceso |
|------|-------------|--------|
| `/` | Lista de estudios | Público |
| `/viewer/:studyInstanceUID` | Visor de estudio | Público |
| `/config` | Configuración | Admin solamente |

## Herramientas de Desarrollo

```bash
# Ejecutar en modo desarrollo
npm run dev

# Compilar para producción
npm run build

# Vista previa de la compilación
npm run preview

# Lint
npm run lint
```

## Endpoints DICOMweb

El visor utiliza los siguientes endpoints de dcm4chee:

| Endpoint | Descripción |
|----------|-------------|
| `GET /studies` | Buscar estudios |
| `GET /studies/{studyUID}/series` | Obtener series |
| `GET /studies/{studyUID}/series/{seriesUID}/instances` | Obtener instancias |
| `GET /studies/{studyUID}/series/{seriesUID}/instances/{instanceUID}/metadata` | Metadata completa |
| `GET /wado?requestType=WADO&...` | Recuperar imágenes |
| `POST /studies` | Publicar DICOM SEG mediante STOW-RS |

## Endpoints de Segmentación

El archivo DICOM SEG se almacena en el PACS. La API de reportes conserva únicamente sus metadatos y versionado:

| Endpoint | Descripción |
|----------|-------------|
| `GET /report-api/segmentation-objects` | Listar segmentaciones por estudio/serie |
| `POST /report-api/segmentation-objects` | Registrar una nueva versión DICOM SEG |
| `GET /report-api/segmentation-objects/:id` | Obtener metadatos de una segmentación |
| `PATCH /report-api/segmentation-objects/:id` | Actualizar nombre, descripción o estado |

## Configuración de Features

Los administradores pueden habilitar/deshabilitar features desde `/config`:

- **MPR**: Activa/desactiva el modo MPR para CT
- **Descarga DICOM**: Permite descargar estudios como ZIP
- **Herramientas de Medición**: Activa/desactiva anotaciones
- **MINICAT SINUS**: Activa el panel anatómico, Labelmap voxel y persistencia DICOM SEG
- **Presets W/L**: Muestra presets de window/level
- **Filmstrip**: Muestra la barra de miniaturas

## Licencia

MIT License - ver [LICENSE](LICENSE) para más detalles.

## Créditos

- [Cornerstone.js](https://cornerstonejs.org/) - Librería de visualización DICOM
- [dcm4chee](https://dcm4che.org/) - Archive PACS
- [Keycloak](https://www.keycloak.org/) - Autenticación
- [React](https://reactjs.org/) - Framework UI
- [Vite](https://vitejs.dev/) - Build tool

## Soporte

Para issues y preguntas, usar el [Issue Tracker](https://github.com/FacuFarias/NextViewer4.0/issues).
