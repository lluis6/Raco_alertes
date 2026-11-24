/**
 * Racó FIB → correo
 *
 * Consulta periódicamente los avisos del Racó mediante la API de la FIB (v2)
 * y envía un correo con el contenido completo de cada aviso nuevo.
 *
 * Dependencia: biblioteca OAuth2 for Apps Script
 *   ID: 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF
 *   Identificador: OAuth2
 *
 * Configuración: Propiedades del script (Configuración del proyecto).
 *   FIB_CLIENT_ID      (obligatoria) client_id de la aplicación registrada en la API de la FIB
 *   FIB_CLIENT_SECRET  (obligatoria) client_secret de la aplicación
 *   EMAIL_TO           (opcional)    destinatario; por defecto, la cuenta propietaria del script
 *   EMAIL_FROM         (opcional)    remitente; debe ser un alias "Enviar como" verificado en Gmail
 *   SEND_EXISTING      (opcional)    "true" para enviar también los avisos ya existentes
 *                                    en la primera ejecución
 *
 * Funciones para ejecutar manualmente: showRedirectUri, authorize, checkAvisos,
 * installTrigger, debugAvisos, resetSeen, resendLast3.
 */

const API = 'https://api.fib.upc.edu/v2';
const AUTH_URL = API + '/o/authorize/';
const TOKEN_URL = API + '/o/token/';
const AVISOS_URL = API + '/jo/avisos/?format=json';
const MAX_SEEN = 400;                      // IDs recordados (límite de 9 KB por propiedad)
const ERROR_COOLDOWN_MS = 6 * 3600 * 1000; // como máximo un correo de error cada 6 h
const FETCH_ATTEMPTS = 4;                  // intentos por petición ante errores temporales (502, 503...)
const FETCH_BACKOFF_MS = 2000;             // espera inicial entre intentos (se duplica: 2 s, 4 s, 8 s)
const TRANSIENT_FAILS_BEFORE_MAIL = 3;     // ejecuciones seguidas con error temporal antes de avisar (3 x 10 min)

/* ============================== Utilidades ============================== */

function props_() {
  return PropertiesService.getScriptProperties();
}

/** Escapa texto plano para insertarlo en HTML. */
function esc_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convierte entidades HTML (&agrave;, &#224;, &#xE0;...) en caracteres Unicode. */
function decodeEntities_(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    agrave: 'à', aacute: 'á', egrave: 'è', eacute: 'é', iacute: 'í', iuml: 'ï',
    ograve: 'ò', oacute: 'ó', uacute: 'ú', uuml: 'ü', ccedil: 'ç', ntilde: 'ñ',
    Agrave: 'À', Aacute: 'Á', Egrave: 'È', Eacute: 'É', Iacute: 'Í', Iuml: 'Ï',
    Ograve: 'Ò', Oacute: 'Ó', Uacute: 'Ú', Uuml: 'Ü', Ccedil: 'Ç', Ntilde: 'Ñ',
    middot: '·', laquo: '«', raquo: '»', ndash: '–', mdash: '—',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', euro: '€'
  };
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, n) => (n in named ? named[n] : m));
}

/**
 * Devuelve el nombre de quien publica el aviso, si la API lo incluye.
 * Los nombres de campo son los más probables; ejecuta debugAvisos() para ver
 * cuál usa realmente la API.
 */
function autor_(a) {
  const keys = ['autor', 'author', 'professor', 'emissor', 'creador', 'remitent',
                'publicat_per', 'usuari', 'persona'];
  for (const k of keys) {
    const v = a[k];
    if (!v) continue;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      const nom = v.nom_complet || v.nom || v.name;
      if (nom) return (nom + ' ' + (v.cognoms || '')).trim();
    }
  }
  return '';
}

/* ============================ Autorización OAuth2 ============================ */

function getService_() {
  const p = props_();
  return OAuth2.createService('fib')
    .setAuthorizationBaseUrl(AUTH_URL)
    .setTokenUrl(TOKEN_URL)
    .setClientId(p.getProperty('FIB_CLIENT_ID'))
    .setClientSecret(p.getProperty('FIB_CLIENT_SECRET'))
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setScope('read');
}

/** Paso 1: muestra en el registro la redirect URI que hay que dar al registrar la aplicación. */
function showRedirectUri() {
  Logger.log(getService_().getRedirectUri());
}

/** Paso 2: muestra la URL de autorización. Ábrela en el mismo navegador y cuenta de Google. */
function authorize() {
  const service = getService_();
  if (service.hasAccess()) {
    Logger.log('Ya estás autorizado.');
    return;
  }
  Logger.log('Abre esta URL:\n' + service.getAuthorizationUrl());
}

/** Callback invocado por la FIB tras la autorización. */
function authCallback(request) {
  const ok = getService_().handleCallback(request);
  return HtmlService.createHtmlOutput(
    '<meta charset="utf-8">' +
    (ok ? 'Autorizado. Puedes cerrar esta pestaña.' : 'Autorización denegada.')
  );
}

/* ============================== Lógica principal ============================== */

/** Quita etiquetas HTML y espacios sobrantes para que los mensajes de error sean legibles. */
function plain_(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * UrlFetchApp.fetch con reintentos y espera exponencial ante errores temporales:
 * excepciones de red, 429 y 5xx (p. ej. el "502 Proxy Error" que a veces devuelve la FIB).
 * Devuelve siempre la última respuesta (aunque sea un error) o lanza la última excepción.
 */
function fetchRetry_(url, options, attempts) {
  attempts = attempts || FETCH_ATTEMPTS;
  options = Object.assign({ muteHttpExceptions: true }, options);
  let lastErr = null;
  let res = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) Utilities.sleep(FETCH_BACKOFF_MS * Math.pow(2, i - 1));
    try {
      res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      if (code !== 429 && code < 500) return res;
      lastErr = null;
      Logger.log('Intento ' + (i + 1) + '/' + attempts + ': HTTP ' + code);
    } catch (e) {
      res = null;
      lastErr = e;
      Logger.log('Intento ' + (i + 1) + '/' + attempts + ': ' + e.message);
    }
  }
  if (res) return res;
  throw lastErr;
}

/** Crea un error marcado como temporal (reintentable) o permanente. */
function makeError_(msg, transient) {
  const e = new Error(msg);
  e.transient = !!transient;
  return e;
}

/** Obtiene los avisos del usuario desde la API. */
function fetchAvisos_() {
  const service = getService_();
  if (!service.hasAccess()) {
    throw makeError_('Sin autorización: vuelve a ejecutar authorize().', false);
  }

  let res;
  try {
    res = fetchRetry_(AVISOS_URL, {
      headers: {
        Authorization: 'Bearer ' + service.getAccessToken(),
        Accept: 'application/json'
      }
    });
  } catch (e) {
    // Fallo de red o al renovar el token: se trata como temporal.
    throw makeError_('Error de red: ' + e.message, true);
  }

  const code = res.getResponseCode();
  if (code !== 200) {
    const transient = code === 429 || code >= 500;
    throw makeError_('HTTP ' + code + ': ' + plain_(res.getContentText('UTF-8')).slice(0, 300), transient);
  }

  let data;
  try {
    data = JSON.parse(res.getContentText('UTF-8'));
  } catch (e) {
    throw makeError_('Respuesta no válida de la API: ' + plain_(res.getContentText('UTF-8')).slice(0, 200), true);
  }
  return Array.isArray(data) ? data : (data.results || []);
}

/** Punto de entrada del activador: envía un correo por cada aviso nuevo. */
function checkAvisos() {
  const p = props_();

  let avisos;
  try {
    avisos = fetchAvisos_();
  } catch (e) {
    notifyError_(e);
    return;
  }
  p.deleteProperty('FAIL_COUNT');

  const raw = p.getProperty('SEEN_IDS');
  const firstRun = raw === null;
  const seen = new Set(firstRun ? [] : JSON.parse(raw));

  // Primera ejecución: se marcan los avisos existentes como vistos para evitar una avalancha.
  if (firstRun && p.getProperty('SEND_EXISTING') !== 'true') {
    p.setProperty('SEEN_IDS', JSON.stringify(avisos.map(a => String(a.id)).slice(-MAX_SEEN)));
    Logger.log('Primera ejecución: ' + avisos.length + ' avisos marcados como vistos.');
    return;
  }

  const nuevos = avisos
    .filter(a => !seen.has(String(a.id)))
    .sort((a, b) => String(a.data_insercio || '').localeCompare(String(b.data_insercio || '')));

  nuevos.forEach(a => {
    sendMail_(a);
    seen.add(String(a.id));
    // Se persiste tras cada envío para no duplicar correos si la ejecución se interrumpe.
    p.setProperty('SEEN_IDS', JSON.stringify(Array.from(seen).slice(-MAX_SEEN)));
  });

  Logger.log(nuevos.length + ' avisos nuevos enviados.');
}

/** Descarga un adjunto usando el token OAuth2. Devuelve un Blob o null si falla. */
function fetchAdjunto_(x) {
  const url = typeof x === 'string' ? x : (x.url || '');
  if (!url) return null;
  try {
    const res = fetchRetry_(url, {
      headers: { Authorization: 'Bearer ' + getService_().getAccessToken() },
      followRedirects: true
    }, 3);
    if (res.getResponseCode() !== 200) {
      Logger.log('Adjunto no descargable (' + res.getResponseCode() + '): ' + url);
      return null;
    }

    // Nombre: campo de la API, o cabecera Content-Disposition, o genérico.
    let name = typeof x === 'string' ? '' : decodeEntities_(x.nom || x.nom_fitxer || '');
    if (!name || /^https?:/i.test(name)) {
      const h = res.getHeaders();
      const cd = h['Content-Disposition'] || h['content-disposition'] || '';
      const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      name = m ? decodeURIComponent(m[1]) : 'adjunto';
    }
    return res.getBlob().setName(name);
  } catch (e) {
    Logger.log('Error descargando adjunto: ' + e.message);
    return null;
  }
}

/** Construye y envía el correo de un aviso. */
function sendMail_(a) {
  const p = props_();
  const to = p.getProperty('EMAIL_TO') || Session.getEffectiveUser().getEmail();
  const from = p.getProperty('EMAIL_FROM');

  const assig = decodeEntities_(a.codi_assig);
  const titol = decodeEntities_(a.titol) || '(sin título)';
  const autor = decodeEntities_(autor_(a));
  const racoUrl = 'https://raco.fib.upc.edu/avisos/veure.jsp?espai=' + encodeURIComponent(assig);

  // Los adjuntos se descargan con el token y se añaden al correo como archivos.
  const attachments = [];
  let adjuntos = '';
  if (Array.isArray(a.adjunts) && a.adjunts.length) {
    const items = a.adjunts.map(x => {
      const blob = fetchAdjunto_(x);
      if (blob) {
        attachments.push(blob);
        return '<li>' + esc_(blob.getName()) + ' (adjunto a este correo)</li>';
      }
      const nom = typeof x === 'string' ? 'adjunto' : (x.nom || x.nom_fitxer || 'adjunto');
      return '<li>' + esc_(decodeEntities_(nom)) +
             ' (no se pudo descargar; <a href="' + esc_(racoUrl) + '">descárgalo desde el Racó</a>)</li>';
    });
    adjuntos = '<p><b>Adjuntos:</b></p><ul>' + items.join('') + '</ul>';
  }

  const html =
    '<meta charset="utf-8">' +
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">' +
    '<h2>' + esc_(titol) + '</h2>' +
    '<p><b>Asignatura:</b> ' + esc_(assig) + '<br>' +
    (autor ? '<b>Publicado por:</b> ' + esc_(autor) + '<br>' : '') +
    '<b>Publicado:</b> ' + esc_(a.data_insercio || '') + '<br>' +
    '<b>Modificado:</b> ' + esc_(a.data_modificacio || '') + '<br>' +
    '<b>Caduca:</b> ' + esc_(a.data_caducitat || '') + '</p>' +
    '<hr>' + (a.text || '') + adjuntos +
    '<hr><p><a href="' + esc_(racoUrl) + '">Ver en el Racó</a></p>' +
    '</div>';

  const subject = '[Racó] ' + (assig ? assig + ': ' : '') + titol;

  if (from) {
    // Solo funciona si "from" es un alias "Enviar como" verificado en el Gmail propietario.
    GmailApp.sendEmail(to, subject, '', { htmlBody: html, from: from, attachments: attachments });
  } else {
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, attachments: attachments });
  }
}

/**
 * Avisa por correo de un fallo de consulta, como máximo una vez cada 6 horas.
 * Los errores temporales (502, red...) solo se notifican si se repiten en
 * TRANSIENT_FAILS_BEFORE_MAIL ejecuciones seguidas; los permanentes (sin
 * autorización, 401/403...) se notifican de inmediato.
 */
function notifyError_(e) {
  const p = props_();
  const now = Date.now();
  Logger.log('Error: ' + e.message);

  const fails = Number(p.getProperty('FAIL_COUNT') || 0) + 1;
  p.setProperty('FAIL_COUNT', String(fails));
  if (e.transient && fails < TRANSIENT_FAILS_BEFORE_MAIL) return;

  if (now - Number(p.getProperty('LAST_ERROR_TS') || 0) < ERROR_COOLDOWN_MS) return;
  p.setProperty('LAST_ERROR_TS', String(now));
  const to = p.getProperty('EMAIL_TO') || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, '[Racó] Error al consultar los avisos',
    String(e.message) + (e.transient ? '\n\n(Fallo repetido en ' + fails + ' consultas seguidas.)' : ''));
}

/* ============================ Administración ============================ */

/** Crea el activador periódico (cada 10 minutos). Sustituye cualquier activador previo. */
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkAvisos')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkAvisos').timeBased().everyMinutes(10).create();
}

/** Registra el JSON crudo del primer aviso para ver qué campos devuelve la API. */
function debugAvisos() {
  const avisos = fetchAvisos_();
  Logger.log(avisos.length + ' avisos');
  if (avisos.length) Logger.log(JSON.stringify(avisos[0], null, 2));
}

/** Olvida los avisos vistos; la siguiente ejecución vuelve a empezar de cero. */
function resetSeen() {
  props_().deleteProperty('SEEN_IDS');
}

/**
 * Reenvía por correo los últimos n avisos (por defecto 3), sin importar si ya se
 * enviaron. No modifica la lista de avisos vistos. Se envían del más antiguo al más reciente.
 */
function resendLast(n) {
  n = n || 3;
  let avisos;
  try {
    avisos = fetchAvisos_();
  } catch (e) {
    Logger.log('Error: ' + e.message);
    throw e;
  }
  const ultimos = avisos
    .slice()
    .sort((a, b) => String(b.data_insercio || '').localeCompare(String(a.data_insercio || '')))
    .slice(0, n)
    .reverse();
  ultimos.forEach(sendMail_);
  Logger.log(ultimos.length + ' avisos reenviados.');
}

/** Atajo ejecutable desde el editor: reenvía los 3 últimos avisos. */
function resendLast3() {
  resendLast(3);
}
