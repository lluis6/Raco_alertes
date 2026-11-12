# Racó Avisos → Correo

Script de Google Apps Script que consulta periódicamente los avisos del [Racó de la FIB](https://raco.fib.upc.edu) a través de la [API de la FIB](https://api.fib.upc.edu/) y envía un correo con el **contenido completo** de cada aviso nuevo. Las notificaciones propias del Racó solo avisan de que hay un aviso, sin incluir su contenido.

> Proyecto independiente, sin relación oficial con la FIB ni con la UPC.

## Características

- Un correo HTML por aviso nuevo, con asignatura, fechas, texto, adjuntos y enlace al Racó.
- Autenticación OAuth 2.0: **tu usuario y contraseña de la UPC nunca pasan por el script**. Se introducen una sola vez en el navegador, durante la autorización.
- Los tokens se renuevan automáticamente.
- Sin servidor ni base de datos: se ejecuta en Google Apps Script con un activador por tiempo.
- En la primera ejecución marca los avisos existentes como vistos para no enviar una avalancha de correos.
- Si falla la consulta, envía un correo de error como máximo una vez cada 6 horas.

## Requisitos

- Una cuenta de Google (el script se ejecuta y envía los correos desde ella).
- Una aplicación registrada en la API de la FIB, con su `client_id` y `client_secret`.
- La biblioteca [OAuth2 for Apps Script](https://github.com/googleworkspace/apps-script-oauth2).

## Instalación

### 1. Crear el proyecto

1. Crea un proyecto en [script.google.com](https://script.google.com).
2. Copia el contenido de `Code.gs` en el proyecto.
3. Añade la biblioteca OAuth2: *Bibliotecas* > **+** > ID `1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF`, identificador `OAuth2`.

También puedes usar [clasp](https://github.com/google/clasp) con los archivos de este repositorio (`appsscript.json` incluido).

### 2. Registrar la aplicación en la API de la FIB

1. Ejecuta `showRedirectUri()` y copia la URL que aparece en *Ver > Registros de ejecución*. Tiene el formato `https://script.google.com/macros/d/<ID_DEL_SCRIPT>/usercallback`.
2. En [api.fib.upc.edu](https://api.fib.upc.edu/) registra una aplicación con esa URL como *redirect URI*.
3. Guarda el `client_id` y el `client_secret` que te asignen.

### 3. Configurar las propiedades del script

En *Configuración del proyecto* > *Propiedades de la secuencia de comandos*:

| Propiedad | Obligatoria | Descripción |
|---|---|---|
| `FIB_CLIENT_ID` | Sí | `client_id` de la aplicación registrada. |
| `FIB_CLIENT_SECRET` | Sí | `client_secret` de la aplicación. |
| `EMAIL_TO` | No | Destinatario. Por defecto, la cuenta propietaria del script. |
| `EMAIL_FROM` | No | Remitente. Debe ser un alias "Enviar como" ya verificado en el Gmail propietario del script. |
| `SEND_EXISTING` | No | `true` para enviar también los avisos existentes en la primera ejecución. |

Las propiedades no se incluyen en el código ni en el repositorio. **No subas nunca el `client_secret` a GitHub.**

### 4. Autorizar y activar

1. Ejecuta `authorize()`, abre la URL que aparece en el registro e inicia sesión con tu usuario de la UPC.
2. Ejecuta `checkAvisos()` una vez: marcará los avisos existentes como vistos.
3. Ejecuta `installTrigger()` para consultar la API cada 10 minutos.

## Funciones

| Función | Uso |
|---|---|
| `showRedirectUri()` | Muestra la redirect URI para el registro de la aplicación. |
| `authorize()` | Muestra la URL de autorización OAuth2. |
| `checkAvisos()` | Consulta los avisos y envía los nuevos. Es la función que ejecuta el activador. |
| `installTrigger()` | Crea el activador periódico (sustituye el anterior). |
| `debugAvisos()` | Muestra en el registro el JSON crudo del primer aviso. |
| `resetSeen()` | Olvida los avisos vistos. |

## Frecuencia y cuotas

El activador se ejecuta cada 10 minutos, así que un aviso llega con un retraso máximo aproximado de ese tiempo. Para cambiarlo, modifica `everyMinutes(10)` en `installTrigger()` (valores admitidos: 1, 5, 10, 15 y 30) y vuelve a ejecutar la función. Consulta las [cuotas de Apps Script](https://developers.google.com/apps-script/guides/services/quotas) de tu tipo de cuenta antes de bajar de 5 minutos.

## Solución de problemas

**"El token de estado no es válido o ha caducado"** al autorizar. Google ha ejecutado el callback con una cuenta distinta de la que lanzó `authorize()`. Abre una ventana de incógnito, inicia sesión solo con la cuenta propietaria del script, ejecuta `authorize()` y abre la URL en esa misma ventana. Usa siempre la URL recién generada.

**`HTTP 401` o `Sin autorización`.** Vuelve a ejecutar `authorize()`.

**Faltan campos en el correo (fechas, asignatura, autor).** Los nombres de campo del aviso se han inferido y pueden no coincidir con los reales. Ejecuta `debugAvisos()` y adapta `sendMail_()` y `autor_()` en `Code.gs`.

**No se puede usar `EMAIL_FROM`.** Gmail solo permite enviar desde direcciones configuradas como alias en *Configuración > Cuentas e importación > Enviar como*.

## Limitaciones

- Se detectan avisos nuevos por su ID: un aviso editado después no se reenvía.
- Se recuerdan los últimos 400 avisos vistos (límite de tamaño de las propiedades del script).
- El campo con el autor del aviso solo aparece si la API lo devuelve.

## Seguridad

- Las credenciales de la aplicación se guardan en las propiedades del script y los tokens OAuth2 en las propiedades de usuario, nunca en el código.
- El script pide acceso de lectura (`read`) a la API de la FIB y permiso para enviar correo desde tu cuenta de Google.
- Puedes revocar el acceso en cualquier momento desde la configuración de tu cuenta de la FIB y en [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Estructura

```
.
├── Code.gs          # Lógica del script
├── appsscript.json  # Manifiesto del proyecto (zona horaria, biblioteca OAuth2)
└── README.md
```
