# FireWatch IA

Menú con dos secciones: **Mapa** (pantalla completa + un panel de chat con IA) e **Información de incendios** (cómo se producen y cómo evitarlos). **Todas las funciones pasan por la IA**:
ubicación, comparación, estadísticas, prevención y simulador. Los botones solo arrancan la frase.

## Cómo correrlo

1. Instalá Node 20.6 o superior (https://nodejs.org).
2. Copiá `.env.example` como `.env` y completá:
   - `GROQ_API_KEY` (IA gratis, sin tarjeta): https://console.groq.com/keys
   - `FIRMS_MAP_KEY`: gratis en https://firms.modaps.eosdis.nasa.gov/api/map_key/
3. En esta carpeta: `npm start`
4. Abrí http://localhost:3000

No hay que instalar paquetes (`npm install` no hace falta).

## Cuentas de usuario (login y registro)

- Se puede crear una cuenta con email y contraseña, o entrar con Google.
- Sin iniciar sesión no se puede usar el mapa ni el asistente (así nadie gasta tu cuota de IA).
- Las cuentas se guardan en la carpeta `data/` (`users.json` y `sessions.json`). Las contraseñas se guardan cifradas (scrypt), nunca en texto plano.
  **No subas `data/` a GitHub** (ya está en `.gitignore`) y hacé copias de seguridad si importa conservar las cuentas.
- Las sesiones duran 7 días. Hay un límite de intentos para frenar a quien prueba contraseñas.
- Este sistema de archivos sirve para un proyecto personal o una demo. Para muchos usuarios conviene pasar a una base de datos.

## Activar el login con Google

El botón de Google necesita un "ID de cliente" que se crea gratis en Google Cloud (no hace falta tarjeta ni "client secret"):

1. Entrá a https://console.cloud.google.com e iniciá sesión con tu cuenta de Google.
2. Creá un proyecto nuevo (arriba, selector de proyectos → "Proyecto nuevo").
3. Andá a **APIs y servicios → Pantalla de consentimiento de OAuth** (en versiones nuevas se llama **Google Auth Platform**).
   Elegí tipo **Externo**, poné el nombre de la app (FireWatch IA) y tu email de contacto, y guardá.
   Mientras la app esté en modo "Prueba", solo pueden entrar los emails que agregues como **usuarios de prueba**. Agregá el tuyo.
4. Andá a **Credenciales → Crear credenciales → ID de cliente de OAuth**.
   - Tipo de aplicación: **Aplicación web**.
   - En **Orígenes autorizados de JavaScript** agregá estas dos direcciones:
     `http://localhost:3000` y `http://localhost`
   - No hace falta completar "URI de redireccionamiento".
5. Copiá el **ID de cliente** (termina en `.apps.googleusercontent.com`) y pegalo en el `.env`:
   `GOOGLE_CLIENT_ID=tu-id.apps.googleusercontent.com`
6. Reiniciá el servidor (Ctrl+C y `npm.cmd start`). En la pantalla de ingreso aparece el botón "Continuar con Google".

Si publicás el sitio en internet, agregá también la dirección de tu sitio (con `https://`) en "Orígenes autorizados" y poné `COOKIE_SECURE=1` en las variables de entorno.
Los nombres de los menús de Google Cloud cambian de vez en cuando; si no encontrás una opción, buscala por el nombre en el buscador de la consola.

## Cómo está integrado

```
Navegador (public/)  ──►  server.js  ──►  IA (Groq, Grok, Gemini o Claude)
   mapa + chat              │                 │ decide qué herramienta usar
                            │◄────────────────┘
                            ├─► NASA FIRMS     focos de calor reales (VIIRS)
                            ├─► Nominatim      buscar lugares
                            ├─► Open-Meteo     clima para riesgo / simulador
                            └─► NASA GIBS      imágenes antes/después (se cargan en el navegador)
```

La IA usa *tool calling*: en `server.js` están definidas 4 herramientas (`TOOLS`) y su código (`IMPL`).
El modelo elige cuáles llamar, el servidor las ejecuta, le devuelve los datos reales y la IA redacta la
respuesta. Además el servidor devuelve `mapActions` para que el navegador dibuje focos o abra la comparación.

## Agregar otra fuente de datos

1. Agregá una herramienta en `TOOLS` (nombre, descripción, parámetros).
2. Escribí su función en `IMPL`.
3. Si querés que se vea en el mapa, hacé `actions.push({...})` y manejalo en `applyActions` (`public/app.js`).

## Cambiar de modelo o de proveedor

Por defecto usa Groq (plan gratis) si hay `GROQ_API_KEY`; si no, Grok, Gemini o Claude. El modelo se cambia con `AI_MODEL` en `.env`; si da error 404, copiá
el nombre exacto desde Google AI Studio. Para forzar otra IA con varias claves cargadas, usá `AI_PROVIDER=grok`, `gemini` o `claude`.
Para sumar otro proveedor con formato OpenAI (OpenRouter, Cerebras…), agregá una línea con `openaiLike({...})` en `ADAPTERS`.

## Notas importantes

- La clave de IA **nunca** va en el JavaScript del navegador: por eso existe el servidor.
- Un foco de calor **no es un incendio confirmado**. La IA está instruida para aclararlo.
- Satélites: Suomi NPP dejó de entregar datos a FIRMS el 2/11/2026. Se usan NOAA-20 y NOAA-21 (mismo sensor VIIRS, ~50 min de diferencia entre pasadas, por eso un mismo incendio puede contar 2 detecciones). Las imágenes antes/después usan NOAA-20.
- FIRMS: datos recientes (NRT) cubren aprox. los últimos 2 meses; para fechas anteriores el servidor usa el archivo
  `VIIRS_SNPP_SP`. Cada consulta admite como máximo 5 días. Si una comparación falla, revisá disponibilidad en
  https://firms.modaps.eosdis.nasa.gov/api/data_availability/
- El plan gratis de Gemini tiene límites por minuto y por día; si se agotan, el chat avisa y hay que esperar.
  Google puede usar lo que enviás en el plan gratis para mejorar sus productos: no cargues datos privados.
- Hay un límite de 15 consultas por minuto por IP para controlar el gasto de la IA.
- Se quitó el login porque era falso. Si necesitás usuarios, hay que agregar autenticación real en el servidor.
- Para publicarlo en internet usá un hosting que corra Node (Render, Railway, Fly.io) y cargá las claves como
  variables de entorno, no subas el `.env`.
