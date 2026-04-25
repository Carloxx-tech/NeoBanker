/* ═══════════════════════════════════════════════════════════════
   NEOBANKER — app.js  |  PARTE 1: Bootstrap, estado, utilidades
   Vanilla JS · Firebase v10 · ES6 Modules
   ═══════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════
   1. IMPORTS
══════════════════════════════════════════════════════════════ */
import { initializeApp }                          from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously,
         onAuthStateChanged }                     from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, set, get, push,
         onValue, runTransaction, remove,
         update }                                 from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { FIREBASE_CONFIG }                        from './config.js';

/* ══════════════════════════════════════════════════════════════
   2. CONSTANTES
══════════════════════════════════════════════════════════════ */

/** Paleta de avatares de jugador */
const COLORES = [
  { id: 'rojo',     nombre: 'Rojo',     hex: '#E74C3C' },
  { id: 'azul',     nombre: 'Azul',     hex: '#3498DB' },
  { id: 'verde',    nombre: 'Verde',    hex: '#27AE60' },
  { id: 'amarillo', nombre: 'Amarillo', hex: '#F1C40F' },
  { id: 'morado',   nombre: 'Morado',   hex: '#8E44AD' },
  { id: 'naranja',  nombre: 'Naranja',  hex: '#E67E22' },
];

/**
 * Caracteres para generar el código de sala.
 * Se excluyen O, 0, I, 1 para evitar confusiones visuales.
 */
const CHARS_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ══════════════════════════════════════════════════════════════
   3. ESTADO GLOBAL
══════════════════════════════════════════════════════════════ */

/**
 * Fuente única de verdad de la sesión actual.
 * Toda la UI lee desde aquí; Firebase escribe aquí vía listeners.
 */
const state = {
  /** UID anónimo de Firebase Auth del usuario local */
  uid: null,

  /** Código de 6 caracteres de la sala activa (ej: "AB3X7K") */
  codigoSala: null,

  /** true si este cliente es el host de la sala */
  esHost: false,

  /**
   * Pantalla activa dentro de la app.
   * Valores posibles: 'home' | 'crear' | 'unirse' | 'perfil' |
   *                   'lobby' | 'billetera' | 'cajero'
   */
  modoActual: null,

  /**
   * Metadatos de la sala (nombre, saldoInicial, modoEstricto, hostUid…)
   * Refleja el nodo /salas/{codigo}/meta en Firebase.
   */
  meta: null,

  /**
   * Mapa de jugadores de la sala.
   * Clave: uid   Valor: { uid, nombre, color, saldo }
   * Refleja /salas/{codigo}/jugadores en Firebase.
   */
  jugadores: {},

  /**
   * Array de transacciones ordenadas cronológicamente.
   * Refleja /salas/{codigo}/transacciones en Firebase.
   */
  transacciones: [],

  /** Color seleccionado por flujo */
  colorSeleccionado: {
    host:    null,   // durante screen-crear
    jugador: null,   // durante screen-perfil
  },

  /**
   * Transacción pendiente de confirmación modal (fondos insuficientes).
   * Se guarda aquí hasta que el usuario confirma o cancela.
   */
  pendingTx: null,

  cajero: {
    ranuraActiva: 'izq',
    uidIzq: null, // Quien recibe
    uidDer: null, // Quien paga
    entradaTxt: '',
    montoPendiente: 0
  },
};

/* ══════════════════════════════════════════════════════════════
   4. VARIABLES GLOBALES DE FIREBASE
══════════════════════════════════════════════════════════════ */

/** Instancia de Firebase Realtime Database */
let db;

/** Instancia de Firebase Auth */
let auth;

/**
 * Array de funciones unsubscribe devueltas por onValue().
 * Se limpian al salir de una sala para evitar memory leaks.
 */
const unsubscribers = [];

/* ══════════════════════════════════════════════════════════════
   5. INIT
══════════════════════════════════════════════════════════════ */

/**
 * Punto de entrada de la aplicación.
 * Registra el Service Worker, inicializa Firebase y arranca el flujo
 * de autenticación anónima.
 */
async function init() {
  // ── Service Worker ──────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
      console.info('[SW] Service Worker registrado.');
    } catch (err) {
      // No es crítico: la app funciona igual sin SW
      console.warn('[SW] No se pudo registrar el Service Worker:', err);
    }
  }

  // ── Firebase ─────────────────────────────────────────────────
  const app = initializeApp(FIREBASE_CONFIG);
  db   = getDatabase(app);
  auth = getAuth(app);

  // ── Auth state ───────────────────────────────────────────────
  mostrarLoading(true);

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      // Usuario autenticado (sesión nueva o retomada)
      state.uid = user.uid;
      console.info('[Auth] UID:', state.uid);
      await tryReconnect();
    } else {
      // Sin sesión → login anónimo
      try {
        await signInAnonymously(auth);
        // onAuthStateChanged se disparará de nuevo con el nuevo usuario
      } catch (err) {
        console.error('[Auth] Error en login anónimo:', err);
        mostrarToast('No se pudo conectar. Revisá tu conexión.', 'error');
        mostrarLoading(false);
        mostrarPantalla('screen-home');
      }
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   6. NAVEGACIÓN Y UTILIDADES
══════════════════════════════════════════════════════════════ */

/**
 * Muestra la pantalla con el ID dado y oculta todas las demás.
 * app.js activa/desactiva la clase `.active`; CSS se encarga del resto.
 *
 * @param {string} id - ID del elemento <section> a mostrar
 */
function mostrarPantalla(id) {
  // Ocultamos todas y les volvemos a poner el hidden
  document.querySelectorAll('.screen').forEach((s) => {
    s.classList.remove('active');
    s.setAttribute('hidden', ''); 
  });

  // Mostramos la que necesitamos
  const target = document.getElementById(id);
  if (target) {
    target.classList.add('active');
    target.removeAttribute('hidden'); // <-- Esto es vital
    state.modoActual = id.replace('screen-', '');
  } else {
    console.warn(`[Nav] Pantalla no encontrada: "${id}"`);
  }
}

/**
 * Muestra u oculta el overlay de carga global.
 *
 * @param {boolean} visible
 */
function mostrarLoading(visible) {
  const el = document.getElementById('loading');
  if (!el) return;
  if (visible) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ── Toast ────────────────────────────────────────────────────

/** Referencia al timer de auto-ocultado del toast */
let _toastTimer = null;

/**
 * Muestra una notificación flotante y la oculta automáticamente.
 *
 * @param {string} msg   - Texto a mostrar
 * @param {'success'|'error'|'info'|'warning'} [tipo='info']
 */
function mostrarToast(msg, tipo = 'info') {
  const toast    = document.getElementById('toast');
  const iconEl   = document.getElementById('toast-icon');
  const msgEl    = document.getElementById('toast-message');
  if (!toast) return;

  // Icono según tipo
  const iconos = {
    success: '✓',
    error:   '✕',
    warning: '⚠',
    info:    'ℹ',
  };

  // Limpiar clases anteriores
  toast.classList.remove('show', 'toast--success', 'toast--error', 'toast--warning', 'toast--info');

  // Cancelar timer previo si el toast se llama rápido seguido
  if (_toastTimer) clearTimeout(_toastTimer);

  // Aplicar contenido y clases
  iconEl.textContent = iconos[tipo] ?? iconos.info;
  msgEl.textContent  = msg;
  toast.classList.add('show', `toast--${tipo}`);

  // Auto-ocultar
  _toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    _toastTimer = null;
  }, 3500);
}

// ── Errores inline ───────────────────────────────────────────

/**
 * Muestra un mensaje de error en el hint de un campo.
 *
 * @param {string} hintId - ID del <span class="form__hint">
 * @param {string} msg
 */
function showError(hintId, msg) {
  const el = document.getElementById(hintId);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('error');
}

/**
 * Limpia el mensaje de error de un hint.
 *
 * @param {string} hintId
 */
function hideError(hintId) {
  const el = document.getElementById(hintId);
  if (!el) return;
  el.textContent = '';
  el.classList.remove('error');
}

// ── Formateo ─────────────────────────────────────────────────

/**
 * Formatea un número como dinero en estilo argentino.
 * Ejemplos: 1500 → "$1.500"  |  -300 → "-$300"
 *
 * @param {number} n
 * @returns {string}
 */
/**
/**
 * Formatea un número a estilo Monopoly (M y k).
 * Ejemplos: 1500000 -> "1.5M" | 500000 -> "500k"
 */
function formatMonto(n) {
  const abs = Math.abs(n);
  const signo = n < 0 ? '-' : '';

  if (abs >= 1000000) {
    const valor = abs % 1000000 === 0 ? abs / 1000000 : parseFloat((abs / 1000000).toFixed(2));
    return `${signo}${valor}M`;
  } else if (abs >= 1000) {
    const valor = abs % 1000 === 0 ? abs / 1000 : parseFloat((abs / 1000).toFixed(1));
    return `${signo}${valor}k`;
  }

  return `${signo}${abs}`;
}

/**
 * Convierte un texto con M o k a número real para la base de datos.
 * Ejemplos: "1.5M" -> 1500000 | "500k" -> 500000 | "200" -> 200
 */
function parseMonto(str) {
  if (!str) return 0;
  if (typeof str === 'number') return str;
  
  str = str.toString().toUpperCase().trim().replace(',', '.');
  let multiplicador = 1;
  
  if (str.endsWith('M')) {
    multiplicador = 1000000;
    str = str.replace('M', '');
  } else if (str.endsWith('K')) {
    multiplicador = 1000;
    str = str.replace('K', '');
  }
  
  const num = parseFloat(str);
  return isNaN(num) ? 0 : Math.round(num * multiplicador);
}

// ── Color helpers ────────────────────────────────────────────

/**
 * Devuelve el hex de un color dado su ID.
 *
 * @param {string} colorId
 * @returns {string} hex, o '#888' si no existe
 */
function getColorHex(colorId) {
  return COLORES.find((c) => c.id === colorId)?.hex ?? '#888888';
}

/**
 * Devuelve el emoji representativo de un color.
 *
 * @param {string} colorId
 * @returns {string}
 */
function getColorEmoji(colorId) {
  const emojis = {
    rojo:     '🔴',
    azul:     '🔵',
    verde:    '🟢',
    amarillo: '🟡',
    morado:   '🟣',
    naranja:  '🟠',
  };
  return emojis[colorId] ?? '⚪';
}

/* ══════════════════════════════════════════════════════════════
   7. COLOR PICKER
══════════════════════════════════════════════════════════════ */

/**
 * Renderiza el selector de colores dentro de un contenedor HTML.
 * Limpia el contenedor antes de dibujar para permitir re-renders.
 *
 * @param {string}   containerId      - ID del div.color-picker
 * @param {Function} onSelect         - Callback(colorId: string) al elegir
 * @param {string[]} [coloresOcupados=[]] - IDs de colores no disponibles
 */
function renderColorPicker(containerId, onSelect, coloresOcupados = []) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.warn(`[ColorPicker] Contenedor no encontrado: "${containerId}"`);
    return;
  }

  // Limpiar render anterior (preserva el sr-only si existe)
  container.querySelectorAll('.color-option').forEach((el) => el.remove());

  COLORES.forEach((color) => {
    const esOcupado = coloresOcupados.includes(color.id);

    const btn = document.createElement('button');
    btn.type              = 'button';
    btn.className         = 'color-option' + (esOcupado ? ' ocupado' : '');
    btn.dataset.colorId   = color.id;
    btn.style.background  = color.hex;
    btn.setAttribute('aria-label', color.nombre + (esOcupado ? ' (ocupado)' : ''));
    btn.setAttribute('aria-pressed', 'false');
    btn.disabled          = esOcupado;

    if (!esOcupado) {
      btn.addEventListener('click', () => {
        // Quitar .selected de todos
        container.querySelectorAll('.color-option').forEach((el) => {
          el.classList.remove('selected');
          el.setAttribute('aria-pressed', 'false');
        });

        // Marcar este como seleccionado
        btn.classList.add('selected');
        btn.setAttribute('aria-pressed', 'true');

        // Notificar al llamador
        onSelect(color.id);
      });
    }

    container.appendChild(btn);
  });
}

/* ══════════════════════════════════════════════════════════════
   STUB — implementado en Parte 2
══════════════════════════════════════════════════════════════ */



/* ══════════════════════════════════════════════════════════════
   ARRANQUE
══════════════════════════════════════════════════════════════ */
init();

// [CONTINÚA EN PARTE 2]

/* ═══════════════════════════════════════════════════════════════
   NEOBANKER — app.js  |  PARTE 2: Salas, listeners, lobby
   ═══════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════
   1. GENERADOR DE CÓDIGO ÚNICO
══════════════════════════════════════════════════════════════ */

/**
 * Genera un código alfanumérico de 6 caracteres que no exista ya
 * en Firebase. Reintenta hasta 10 veces antes de lanzar un error.
 *
 * @returns {Promise<string>} Código único de 6 caracteres
 * @throws  {Error} Si no puede encontrar un código libre en 10 intentos
 */
async function generarCodigoUnico() {
  const MAX_INTENTOS = 10;

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    // Generar código aleatorio de CHARS_CODIGO
    let codigo = '';
    for (let i = 0; i < 6; i++) {
      codigo += CHARS_CODIGO[Math.floor(Math.random() * CHARS_CODIGO.length)];
    }

    // Verificar disponibilidad en Firebase
    const snap = await get(ref(db, `salas/${codigo}/meta`));
    if (!snap.exists()) {
      console.info(`[Sala] Código generado en intento ${intento}: ${codigo}`);
      return codigo;
    }

    console.warn(`[Sala] Código ${codigo} ya existe, reintentando…`);
  }

  throw new Error('No se pudo generar un código de sala disponible. Intentá de nuevo.');
}

/* ══════════════════════════════════════════════════════════════
   2. CREAR SALA
══════════════════════════════════════════════════════════════ */

/**
 * Lee el formulario de creación, valida, escribe la sala en Firebase
 * y navega al lobby como host.
 *
 * @returns {Promise<void>}
 */
async function crearSala() {
  // ── Leer inputs ──────────────────────────────────────────────
  const nombreSala   = document.getElementById('input-nombre-sala')?.value.trim()  ?? '';
  const saldoRaw     = document.getElementById('input-saldo-inicial')?.value.trim() ?? '';
  const nombreHost   = document.getElementById('input-nombre-host')?.value.trim()  ?? '';
  const modoEstricto = document.getElementById('toggle-modo-estricto')?.checked    ?? false;
  const colorHost    = state.colorSeleccionado.host;

  // ── Validación ───────────────────────────────────────────────
  let hayErrores = false;

  if (!nombreSala) {
    showError('hint-nombre-sala', 'Ingresá un nombre para la sala.');
    hayErrores = true;
  } else {
    hideError('hint-nombre-sala');
  }

  const saldoInicial = saldoRaw === '' ? 15000000 : parseMonto(saldoRaw);
  if (isNaN(saldoInicial) || saldoInicial < 0) {
    showError('hint-saldo-inicial', 'Ingresá un saldo inicial válido (mínimo $0).');
    hayErrores = true;
  } else {
    hideError('hint-saldo-inicial');
  }

  if (!nombreHost) {
    showError('hint-nombre-host', 'Ingresá tu nombre.');
    hayErrores = true;
  } else {
    hideError('hint-nombre-host');
  }

  if (!colorHost) {
    mostrarToast('Elegí un color antes de continuar.', 'warning');
    hayErrores = true;
  }

  if (hayErrores) return;

  // ── Crear en Firebase ────────────────────────────────────────
  mostrarLoading(true);

  try {
    const codigo    = await generarCodigoUnico();
    const ahora     = Date.now();

    // Estructura de la sala
    const metaSala = {
      hostUid:          state.uid,
      nombre:           nombreSala,
      creadaEn:         ahora,
      ultimaActividadEn: ahora,
      modoEstricto,
      saldoInicial,
      estado:           'lobby',
    };

    const datosHost = {
      uid:      state.uid,
      nombre:   nombreHost,
      color:    colorHost,
      saldo:    saldoInicial,
      esHost:   true,
      unidoEn:  ahora,
    };

    // Escritura atómica: meta + jugador host en una sola operación
    await update(ref(db, `salas/${codigo}`), {
      [`meta`]:                   metaSala,
      [`jugadores/${state.uid}`]: datosHost,
    });

    // ── Persistencia local ─────────────────────────────────────
    localStorage.setItem('neobanker_sala',    codigo);
    localStorage.setItem('neobanker_uid',     state.uid);
    localStorage.setItem('neobanker_nombre',  nombreHost);
    localStorage.setItem('neobanker_color',   colorHost);

    // ── Estado ────────────────────────────────────────────────
    state.codigoSala = codigo;
    state.esHost     = true;
    state.meta       = metaSala;

    // ── Listeners en tiempo real ──────────────────────────────
    setupGameListeners();

    // ── Navegación al lobby ───────────────────────────────────
    _renderizarCodigoLobby(codigo);
    mostrarPantalla('screen-lobby');

  } catch (err) {
    console.error('[crearSala]', err);
    mostrarToast(err.message ?? 'Error al crear la sala. Intentá de nuevo.', 'error');
  } finally {
    mostrarLoading(false);
  }
}

/* ══════════════════════════════════════════════════════════════
   3. BUSCAR SALA (primer paso de unirse)
══════════════════════════════════════════════════════════════ */

/**
 * Valida el código ingresado, verifica la sala en Firebase y navega
 * a la pantalla de perfil para completar el nombre y color.
 *
 * @returns {Promise<void>}
 */
async function buscarSala() {
  const rawInput = document.getElementById('input-codigo-sala')?.value ?? '';
  const codigo   = rawInput.trim().toUpperCase();

  // ── Validación local ─────────────────────────────────────────
  if (codigo.length !== 6) {
    showError('hint-codigo-sala', 'El código debe tener exactamente 6 caracteres.');
    return;
  }
  hideError('hint-codigo-sala');

  mostrarLoading(true);

  try {
    // ── Verificar existencia ─────────────────────────────────
    const snapMeta = await get(ref(db, `salas/${codigo}/meta`));

    if (!snapMeta.exists()) {
      mostrarToast('No existe ninguna sala con ese código.', 'error');
      showError('hint-codigo-sala', 'Sala no encontrada.');
      return;
    }

    const meta = snapMeta.val();

    // ── Verificar expiración (24 h sin actividad) ────────────
    const EXPIRACION_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - (meta.ultimaActividadEn ?? 0) > EXPIRACION_MS) {
      mostrarToast('Esta sala expiró por inactividad.', 'error');
      showError('hint-codigo-sala', 'La sala ya no está disponible.');
      return;
    }

    // ── Verificar que la partida no haya terminado ───────────
    if (meta.estado === 'terminada') {
      mostrarToast('Esta partida ya terminó.', 'error');
      showError('hint-codigo-sala', 'La partida ya finalizó.');
      return;
    }

    // ── Leer jugadores actuales ──────────────────────────────
    const snapJugadores = await get(ref(db, `salas/${codigo}/jugadores`));
    const jugadoresObj  = snapJugadores.val() ?? {};
    const uidsActuales  = Object.keys(jugadoresObj);

    // ── Reconexión directa si ya está en la sala ─────────────
    if (uidsActuales.includes(state.uid)) {
      console.info('[buscarSala] UID ya en sala, reconectando…');
      state.codigoSala = codigo;
      state.esHost     = meta.hostUid === state.uid;
      state.meta       = meta;
      state.jugadores  = jugadoresObj;

      localStorage.setItem('neobanker_sala',  codigo);
      localStorage.setItem('neobanker_uid',   state.uid);

      setupGameListeners();
      _navegarSegunEstado(meta.estado);
      return;
    }

    // ── Verificar capacidad (máx. COLORES.length jugadores) ──
    if (uidsActuales.length >= COLORES.length) {
      mostrarToast('La sala está llena (máximo 6 jugadores).', 'error');
      showError('hint-codigo-sala', 'Sala completa.');
      return;
    }

    // ── Todo ok: guardar estado parcial y navegar al perfil ──
    state.codigoSala = codigo;
    state.meta       = meta;
    state.jugadores  = jugadoresObj;

    // Mostrar nombre de sala en la pantalla de perfil
    const infoNombre = document.getElementById('info-sala-nombre');
    if (infoNombre) infoNombre.textContent = meta.nombre;

    // Colores ya tomados por otros jugadores
    const coloresOcupados = Object.values(jugadoresObj).map((j) => j.color).filter(Boolean);

    renderColorPicker(
      'color-picker-jugador',
      (colorId) => { state.colorSeleccionado.jugador = colorId; },
      coloresOcupados,
    );

    mostrarPantalla('screen-perfil');

  } catch (err) {
    console.error('[buscarSala]', err);
    mostrarToast('Error al buscar la sala. Revisá tu conexión.', 'error');
  } finally {
    mostrarLoading(false);
  }
}

/* ══════════════════════════════════════════════════════════════
   4. UNIRSE A SALA (segundo paso: nombre + color)
══════════════════════════════════════════════════════════════ */

/**
 * Completa el ingreso del jugador a la sala usando una transacción
 * atómica para garantizar que el color elegido no haya sido tomado
 * por otro jugador entre buscarSala() y este momento.
 *
 * @returns {Promise<void>}
 */
async function unirseASala() {
  const nombreJugador = document.getElementById('input-nombre-jugador')?.value.trim() ?? '';
  const colorJugador  = state.colorSeleccionado.jugador;
  const codigo        = state.codigoSala;

  // ── Validación ───────────────────────────────────────────────
  let hayErrores = false;

  if (!nombreJugador) {
    showError('hint-nombre-jugador', 'Ingresá tu nombre.');
    hayErrores = true;
  } else {
    hideError('hint-nombre-jugador');
  }

  if (!colorJugador) {
    mostrarToast('Elegí un color antes de continuar.', 'warning');
    hayErrores = true;
  }

  if (!codigo) {
    mostrarToast('Error interno: código de sala perdido.', 'error');
    return;
  }

  if (hayErrores) return;

  mostrarLoading(true);

  try {
    const refJugadores = ref(db, `salas/${codigo}/jugadores`);
    let txExitosa      = false;
    let motivoFallo    = '';

    // ── Transacción atómica de selección de color ────────────
    await runTransaction(refJugadores, (jugadoresActuales) => {
      // Firebase puede llamar esta función con null la primera vez
      if (jugadoresActuales === null) jugadoresActuales = {};

      // Verificar si el color ya fue tomado
      const coloresTomados = Object.values(jugadoresActuales)
        .map((j) => j.color)
        .filter(Boolean);

      if (coloresTomados.includes(colorJugador)) {
        motivoFallo = 'color-ocupado';
        // Retornar undefined aborta la transacción sin escribir
        return undefined;
      }

      // Verificar capacidad
      if (Object.keys(jugadoresActuales).length >= COLORES.length) {
        motivoFallo = 'sala-llena';
        return undefined;
      }

      // Todo libre: agregar jugador
      jugadoresActuales[state.uid] = {
        uid:     state.uid,
        nombre:  nombreJugador,
        color:   colorJugador,
        saldo:   state.meta?.saldoInicial ?? 1500,
        esHost:  false,
        unidoEn: Date.now(),
      };

      txExitosa = true;
      return jugadoresActuales;
    });

    // ── Manejar resultado de la transacción ──────────────────
    if (!txExitosa) {
      if (motivoFallo === 'color-ocupado') {
        // Limpiar selección y re-renderizar con colores actualizados
        state.colorSeleccionado.jugador = null;

        const snapJugadores   = await get(ref(db, `salas/${codigo}/jugadores`));
        const jugadoresActual = snapJugadores.val() ?? {};
        const coloresOcupados = Object.values(jugadoresActual).map((j) => j.color).filter(Boolean);

        renderColorPicker(
          'color-picker-jugador',
          (colorId) => { state.colorSeleccionado.jugador = colorId; },
          coloresOcupados,
        );

        mostrarToast('Ese color ya fue elegido por otro jugador. Elegí otro.', 'error');
      } else if (motivoFallo === 'sala-llena') {
        mostrarToast('La sala se llenó mientras esperabas. Buscá otra.', 'error');
        salirDeSala();
      }
      return;
    }

    // ── Actualizar actividad de la sala ──────────────────────
    await update(ref(db, `salas/${codigo}/meta`), {
      ultimaActividadEn: Date.now(),
    });

    // ── Persistencia local ────────────────────────────────────
    localStorage.setItem('neobanker_sala',   codigo);
    localStorage.setItem('neobanker_uid',    state.uid);
    localStorage.setItem('neobanker_nombre', nombreJugador);
    localStorage.setItem('neobanker_color',  colorJugador);

    // ── Actualizar state ──────────────────────────────────────
    state.esHost = false;

    // ── Listeners y navegación ────────────────────────────────
    setupGameListeners();
    _renderizarCodigoLobby(codigo);
    mostrarPantalla('screen-lobby');

  } catch (err) {
    console.error('[unirseASala]', err);
    mostrarToast('No se pudo unir a la sala. Intentá de nuevo.', 'error');
  } finally {
    mostrarLoading(false);
  }
}

/* ══════════════════════════════════════════════════════════════
   5. SETUP DE LISTENERS EN TIEMPO REAL
══════════════════════════════════════════════════════════════ */

/**
 * Suscribe los tres listeners de Firebase Realtime Database
 * (meta, jugadores, transacciones) y guarda sus unsubscribers.
 * Siempre llama detachListeners() primero para no duplicar.
 */
function setupGameListeners() {
  detachListeners();

  const codigo = state.codigoSala;
  if (!codigo) {
    console.warn('[Listeners] No hay código de sala, abortando.');
    return;
  }

  // ─── Listener: meta ────────────────────────────────────────
  const unsubMeta = onValue(ref(db, `salas/${codigo}/meta`), (snap) => {
    if (!snap.exists()) {
      // La sala fue eliminada (host terminó la partida o se borró)
      console.info('[Listeners] Sala eliminada de Firebase.');
      mostrarToast('La sala fue cerrada por el host.', 'info');
      salirDeSala();
      return;
    }

    const meta    = snap.val();
    const eraHost = state.esHost;
    state.meta    = meta;
    state.esHost  = meta.hostUid === state.uid;

    // Si el host cambió (transferencia de host) avisar
    if (eraHost && !state.esHost) {
      mostrarToast('Ya no sos el host de esta sala.', 'info');
    } else if (!eraHost && state.esHost) {
      mostrarToast('¡Ahora sos el host de la sala!', 'success');
    }

    // Transición de estado: lobby → activa
    if (meta.estado === 'activa') {
      _navegarSegunEstado('activa');
    } else if (meta.estado === 'terminada') {
      mostrarToast('La partida terminó.', 'info');
      salirDeSala();
    }

    // Re-renderizar lobby si está visible (puede haber cambiado el host)
    if (state.modoActual === 'lobby') {
      renderLobby();
    }
  });

  // ─── Listener: jugadores ───────────────────────────────────
  const unsubJugadores = onValue(ref(db, `salas/${codigo}/jugadores`), (snap) => {
    state.jugadores = snap.val() ?? {};

    switch (state.modoActual) {
      case 'lobby':
        renderLobby();
        break;
      case 'cajero':
        _renderizarSelectorJugadores();
 
        break;
      case 'billetera':
        _actualizarBilletera();
        break;
    }
  });

  // ─── Listener: transacciones ───────────────────────────────
  const unsubTx = onValue(ref(db, `salas/${codigo}/transacciones`), (snap) => {
    const rawTx = snap.val();

    if (!rawTx) {
      state.transacciones = [];
    } else {
      // Firebase push keys garantizan orden cronológico al ordenar
      state.transacciones = Object.entries(rawTx)
        .map(([key, tx]) => ({ ...tx, _key: key }))
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    }

    // Re-renderizar historial según pantalla activa
    if (state.modoActual === 'billetera') {
      _renderizarHistorialPersonal();
    } else if (state.modoActual === 'cajero') {
      _renderizarHistorialMaestro();
    }
  });

  // ── Guardar unsubscribers ─────────────────────────────────
  unsubscribers.push(unsubMeta, unsubJugadores, unsubTx);
  console.info('[Listeners] Listeners activos para sala:', codigo);
}

/* ══════════════════════════════════════════════════════════════
   6. DETACH LISTENERS
══════════════════════════════════════════════════════════════ */

/**
 * Cancela todos los listeners de Firebase activos y vacía el array.
 */
function detachListeners() {
  if (unsubscribers.length === 0) return;
  unsubscribers.forEach((unsub) => {
    if (typeof unsub === 'function') unsub();
  });
  unsubscribers.length = 0;   // mutar en lugar de reasignar (mantiene la referencia)
  console.info('[Listeners] Todos los listeners desconectados.');
}

/* ══════════════════════════════════════════════════════════════
   7. RENDER LOBBY
══════════════════════════════════════════════════════════════ */

/**
 * Renderiza la lista de jugadores en el lobby y muestra/oculta
 * los controles según si el usuario es host o jugador.
 */
function renderLobby() {
  const lista   = document.getElementById('lobby-lista-jugadores');
  const counter = document.getElementById('lobby-count');
  if (!lista) return;

  lista.innerHTML = '';

  const jugadores = Object.values(state.jugadores);

  if (counter) counter.textContent = jugadores.length;

  jugadores.forEach((jugador) => {
    const esEsteHost = jugador.uid === state.meta?.hostUid;
    const hex        = getColorHex(jugador.color);

    const li = document.createElement('li');
    li.className = 'lobby-player-card';
    li.innerHTML = `
      <div class="lobby-player-card__avatar"
           style="background:${hex}"
           aria-hidden="true">
        ${jugador.nombre.charAt(0).toUpperCase()}
      </div>
      <span class="lobby-player-card__name">
        ${_escaparHTML(jugador.nombre)}
        ${jugador.uid === state.uid ? '<span class="badge-yo">(vos)</span>' : ''}
      </span>
      ${esEsteHost
        ? '<span class="lobby-player-card__badge" aria-label="Host">HOST</span>'
        : ''
      }
    `;
    lista.appendChild(li);
  });

  // ── Visibilidad de controles ──────────────────────────────
  const btnIniciar   = document.getElementById('btn-iniciar-partida');
  const msgEsperando = document.getElementById('lobby-esperando');

  if (btnIniciar)   btnIniciar.hidden   = !state.esHost;
  if (msgEsperando) msgEsperando.hidden = state.esHost;
}

/* ══════════════════════════════════════════════════════════════
   8. INICIAR PARTIDA (host)
══════════════════════════════════════════════════════════════ */

/**
 * Cambia el estado de la sala a 'activa', lo que dispara la
 * transición de pantalla en todos los clientes vía el listener de meta.
 *
 * @returns {Promise<void>}
 */
async function iniciarPartida() {
  if (!state.esHost) return;

  const cantJugadores = Object.keys(state.jugadores).length;
  if (cantJugadores < 1) {
    mostrarToast('Necesitás al menos un jugador para iniciar.', 'warning');
    return;
  }

  mostrarLoading(true);
  try {
    await update(ref(db, `salas/${state.codigoSala}/meta`), {
      estado:            'activa',
      iniciadaEn:        Date.now(),
      ultimaActividadEn: Date.now(),
    });
    // La navegación la maneja el listener de meta al detectar estado:'activa'
  } catch (err) {
    console.error('[iniciarPartida]', err);
    mostrarToast('No se pudo iniciar la partida. Intentá de nuevo.', 'error');
  } finally {
    mostrarLoading(false);
  }
}

/* ══════════════════════════════════════════════════════════════
   9. SALIR DE SALA
══════════════════════════════════════════════════════════════ */

/**
 * Cierra la sesión de sala del cliente actual:
 * desconecta listeners, resetea el estado en memoria, limpia
 * localStorage y vuelve a la pantalla de inicio.
 *
 * No elimina los datos de Firebase (eso es responsabilidad del host
 * al terminar la partida).
 */
function salirDeSala() {
  detachListeners();

  // Resetear state a valores iniciales
  state.uid                      = auth?.currentUser?.uid ?? state.uid;
  state.codigoSala               = null;
  state.esHost                   = false;
  state.modoActual               = null;
  state.meta                     = null;
  state.jugadores                = {};
  state.transacciones            = [];
  state.colorSeleccionado.host   = null;
  state.colorSeleccionado.jugador = null;
  state.pendingTx                = null;

  // Limpiar persistencia local
  localStorage.removeItem('neobanker_sala');
  localStorage.removeItem('neobanker_uid');
  localStorage.removeItem('neobanker_nombre');
  localStorage.removeItem('neobanker_color');

  mostrarLoading(false);
  mostrarPantalla('screen-home');
  console.info('[Sala] Sesión de sala cerrada.');
}

/* ══════════════════════════════════════════════════════════════
   10. RECONEXIÓN AL RECARGAR LA PÁGINA
══════════════════════════════════════════════════════════════ */

/**
 * Intenta retomar la sesión de sala usando datos del localStorage.
 * Reemplaza el stub definido en Parte 1.
 *
 * @returns {Promise<boolean>} true si la reconexión fue exitosa
 */
async function tryReconnect() {
  const codigo    = localStorage.getItem('neobanker_sala');
  const uidGuardado = localStorage.getItem('neobanker_uid');

  if (!codigo || !uidGuardado) {
    // Sin sesión guardada → ir a home
    mostrarLoading(false);
    mostrarPantalla('screen-home');
    return false;
  }

  // El UID guardado debe coincidir con el de la sesión actual de Auth
  if (uidGuardado !== state.uid) {
    console.warn('[Reconnect] UID no coincide, limpiando sesión guardada.');
    localStorage.removeItem('neobanker_sala');
    localStorage.removeItem('neobanker_uid');
    mostrarLoading(false);
    mostrarPantalla('screen-home');
    return false;
  }

  try {
    // ── Verificar existencia y frescura de la sala ──────────
    const snapMeta = await get(ref(db, `salas/${codigo}/meta`));

    if (!snapMeta.exists()) {
      console.info('[Reconnect] Sala ya no existe en Firebase.');
      _limpiarSesionLocal();
      mostrarLoading(false);
      mostrarPantalla('screen-home');
      return false;
    }

    const meta = snapMeta.val();

    // Verificar expiración (24 h)
    const EXPIRACION_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - (meta.ultimaActividadEn ?? 0) > EXPIRACION_MS) {
      console.info('[Reconnect] Sala expirada.');
      _limpiarSesionLocal();
      mostrarLoading(false);
      mostrarPantalla('screen-home');
      return false;
    }

    // Verificar que la partida no haya terminado
    if (meta.estado === 'terminada') {
      console.info('[Reconnect] Partida ya terminada.');
      _limpiarSesionLocal();
      mostrarLoading(false);
      mostrarPantalla('screen-home');
      return false;
    }

    // ── Verificar que el UID siga siendo jugador ────────────
    const snapJugador = await get(ref(db, `salas/${codigo}/jugadores/${state.uid}`));

    if (!snapJugador.exists()) {
      console.info('[Reconnect] UID ya no está entre los jugadores.');
      _limpiarSesionLocal();
      mostrarLoading(false);
      mostrarPantalla('screen-home');
      return false;
    }

    // ── Restaurar estado ────────────────────────────────────
    const snapJugadores = await get(ref(db, `salas/${codigo}/jugadores`));

    state.codigoSala = codigo;
    state.esHost     = meta.hostUid === state.uid;
    state.meta       = meta;
    state.jugadores  = snapJugadores.val() ?? {};

    console.info(`[Reconnect] Reconectado a sala ${codigo} como ${state.esHost ? 'HOST' : 'jugador'}.`);

    // ── Activar listeners ────────────────────────────────────
    setupGameListeners();

    // ── Navegar a la pantalla correcta ───────────────────────
    _navegarSegunEstado(meta.estado);

    mostrarLoading(false);
    return true;

  } catch (err) {
    console.error('[Reconnect] Error al reconectar:', err);
    _limpiarSesionLocal();
    mostrarLoading(false);
    mostrarPantalla('screen-home');
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════
   HELPERS INTERNOS (prefijo _)
══════════════════════════════════════════════════════════════ */

/**
 * Vuelca el código de sala en el elemento visual del lobby.
 * @param {string} codigo
 */
function _renderizarCodigoLobby(codigo) {
  const el = document.getElementById('lobby-codigo');
  if (el) el.textContent = codigo;

  const nombreSalaEl = document.getElementById('lobby-nombre-sala');
  if (nombreSalaEl && state.meta?.nombre) {
    nombreSalaEl.textContent = state.meta.nombre;
  }
}

/**
 * Navega a la pantalla adecuada según el estado de la sala.
 * @param {'lobby'|'activa'|'terminada'} estado
 */
function _navegarSegunEstado(estado) {
  if (estado === 'lobby') {
    _renderizarCodigoLobby(state.codigoSala);
    renderLobby();
    mostrarPantalla('screen-lobby');
  } else if (estado === 'activa') {
    // Al usar activarModo, nos aseguramos de que TODO se dibuje al instante
    activarModo(state.esHost ? 'cajero' : 'billetera');
  }
}

/**
 * Limpia los datos de sesión de sala del localStorage.
 */
function _limpiarSesionLocal() {
  localStorage.removeItem('neobanker_sala');
  localStorage.removeItem('neobanker_uid');
  localStorage.removeItem('neobanker_nombre');
  localStorage.removeItem('neobanker_color');
}

/**
 * Escapa caracteres HTML para evitar XSS al inyectar texto dinámico.
 * @param {string} str
 * @returns {string}
 */
function _escaparHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}



// [CONTINÚA EN PARTE 3]

/* ═══════════════════════════════════════════════════════════════
   NEOBANKER — app.js  |  PARTE 3: Render billetera y cajero
   ═══════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════
   1. ACTIVAR MODO
══════════════════════════════════════════════════════════════ */

/**
 * Decide qué pantalla principal mostrar según el rol y el modo pedido,
 * renderiza su contenido y actualiza state.modoActual.
 *
 * @param {'cajero'|'billetera'} modo
 */
function activarModo(modo) {
  if (modo === 'cajero' && state.esHost) {
    state.modoActual = 'cajero';
    renderCajero();
    renderHistorialMaestro();
    mostrarPantalla('screen-cajero');
  } else {
    // Jugador normal, o host que pide ver su billetera
    state.modoActual = 'billetera';
    renderBilletera();
    mostrarPantalla('screen-billetera');
  }
}

/* ══════════════════════════════════════════════════════════════
   2. RENDER BILLETERA
══════════════════════════════════════════════════════════════ */

/**
 * Pinta la pantalla de billetera con los datos del jugador local.
 * Aplica el color del jugador como gradiente en la tarjeta y
 * colorea el saldo en rojo si es negativo.
 */
function renderBilletera() {
  const jugadorLocal = state.jugadores[state.uid];
  if (!jugadorLocal) {
    console.warn('[renderBilletera] Jugador local no encontrado en state.jugadores.');
    return;
  }

  // ── Datos de sala ────────────────────────────────────────────
  const elNombreSala = document.getElementById('billetera-sala-nombre');
  const elCodigoSala = document.getElementById('billetera-codigo-sala');
  if (elNombreSala) elNombreSala.textContent = state.meta?.nombre    ?? '—';
  if (elCodigoSala) elCodigoSala.textContent = state.codigoSala      ?? '—';

  // ── Tarjeta de jugador ───────────────────────────────────────
  const hex     = getColorHex(jugadorLocal.color);
  const hexDim  = _hexADimmer(hex, 0.55);   // versión más oscura para el gradiente

  const tarjeta = document.getElementById('mi-tarjeta');
  if (tarjeta) {
    tarjeta.style.background = `
      linear-gradient(
        135deg,
        ${hexDim} 0%,
        color-mix(in srgb, ${hex} 30%, #1a1a2e 70%) 60%,
        #1a1a2e 100%
      )
    `.trim();
    tarjeta.style.setProperty('--player-color', hex);
    tarjeta.style.borderColor = `${hex}44`;
  }

  // Avatar
  const elAvatar = document.getElementById('wallet-avatar');
  if (elAvatar) {
    elAvatar.style.background = hex;
    const elInicial = document.getElementById('wallet-avatar-inicial');
    if (elInicial) elInicial.textContent = jugadorLocal.nombre.charAt(0).toUpperCase();
  }

  // Nombre
  const elNombre = document.getElementById('card-nombre') ?? document.getElementById('wallet-nombre');
  if (elNombre) elNombre.textContent = _escaparHTML(jugadorLocal.nombre);

  // Sala (subtítulo de la tarjeta)
  const elSalaTarjeta = document.getElementById('wallet-sala');
  if (elSalaTarjeta) elSalaTarjeta.textContent = state.meta?.nombre ?? '—';

  // Badge de rol
  const elBadge = document.getElementById('wallet-badge-rol');
  if (elBadge) {
    elBadge.hidden      = !state.esHost;
    elBadge.textContent = 'HOST';
  }

  // ── Saldo ────────────────────────────────────────────────────
  const saldo   = jugadorLocal.saldo ?? 0;
  const elSaldo = document.getElementById('card-saldo') ?? document.getElementById('wallet-saldo');
  if (elSaldo) {
    elSaldo.textContent = formatMonto(saldo);
    elSaldo.style.color = saldo < 0 ? '#ff6b6b' : '';
    elSaldo.classList.toggle('negative', saldo < 0);
  }

  // ── Botón cajero (solo host) ─────────────────────────────────
  const btnCajero = document.getElementById('btn-toggle-cajero') ?? document.getElementById('btn-ir-cajero');
  if (btnCajero) btnCajero.hidden = !state.esHost;

  // ── Historial personal ───────────────────────────────────────
  renderHistorialPersonal();
}

/* ══════════════════════════════════════════════════════════════
   3. RENDER HISTORIAL PERSONAL
══════════════════════════════════════════════════════════════ */

/**
 * Filtra las transacciones que involucran al jugador local,
 * las ordena de más reciente a más antigua y las pinta en
 * #historial-personal (o #billetera-historial como fallback).
 */
function renderHistorialPersonal() {
  const contenedor = document.getElementById('historial-personal')
                  ?? document.getElementById('billetera-historial');
  const elVacio    = document.getElementById('billetera-historial-vacio');
  if (!contenedor) return;

  // ── Filtrar y ordenar ────────────────────────────────────────
  const uid        = state.uid;
  const misTx      = state.transacciones
    .filter((tx) => tx.origenUid === uid || tx.destinoUid === uid)
    .slice()
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

  // ── Estado vacío ─────────────────────────────────────────────
  if (misTx.length === 0) {
    contenedor.innerHTML = '';
    if (elVacio) {
      elVacio.hidden = false;
    } else {
      contenedor.innerHTML = `<li class="history__empty">Sin movimientos aún.</li>`;
    }
    return;
  }

  if (elVacio) elVacio.hidden = true;

  // ── Renderizar ───────────────────────────────────────────────
  contenedor.innerHTML = '';

  misTx.forEach((tx) => {
    const esIngreso    = tx.destinoUid === uid;
    const tipoClase    = esIngreso ? 'tx-ingreso' : 'tx-egreso';
    const signoMonto   = esIngreso ? '+' : '−';
    const colorMonto   = esIngreso ? 'var(--tx-ingreso)' : 'var(--tx-egreso)';
    const icono        = esIngreso ? '↓' : '↑';

    // Nombre de la contraparte
    const contraparteUid = esIngreso ? tx.origenUid : tx.destinoUid;
    const contraparteNombre = _resolverNombreJugador(contraparteUid);

    // Timestamp formateado
    const fechaStr = tx.timestamp ? _formatearFechaCorta(tx.timestamp) : '';

    // Nota opcional
    const notaHTML = tx.nota
      ? `<span class="tx-item__nota">${_escaparHTML(tx.nota)}</span>`
      : '';

    const li = document.createElement('li');
    li.className = `tx-item ${tipoClase}`;
    li.innerHTML = `
      <div class="tx-item__icon" aria-hidden="true">${icono}</div>
      <div class="tx-item__body">
        <span class="tx-item__desc">${_escaparHTML(contraparteNombre)}</span>
        ${notaHTML}
        <span class="tx-item__meta">${fechaStr}</span>
      </div>
      <span class="tx-item__amount" style="color:${colorMonto}">
        ${signoMonto}${formatMonto(tx.monto)}
      </span>
    `;
    contenedor.appendChild(li);
  });
}

/* ══════════════════════════════════════════════════════════════
   4. RENDER CAJERO
══════════════════════════════════════════════════════════════ */

/**
 * Construye los <select> del formulario de transacción y el
 * selector de transferencia de host. Solo se ejecuta si el
 * usuario es host; aborta silenciosamente si no lo es.
 */
/**
 * Construye los <select> del formulario de transacción y el
 * selector de transferencia de host. 
 */
/* ══════════════════════════════════════════════════════════════
   NUEVO CAJERO MONOPOLY
══════════════════════════════════════════════════════════════ */

function renderCajero() {
  if (!state.esHost) return;
  const lista = document.getElementById('lista-tarjetas-cajero');
  if (!lista) return;

  lista.innerHTML = '';
  const jugadoresArray = Object.values(state.jugadores);

  // 1. Dibujar las tarjetas
  jugadoresArray.forEach(j => {
    const usada = (state.cajero.uidIzq === j.uid) || (state.cajero.uidDer === j.uid);
    const hex = getColorHex(j.color);
    
    lista.innerHTML += `
      <div class="tarjeta ${usada ? 'usada' : ''}" style="background: linear-gradient(135deg, ${hex}, #1a1a2e);" onclick="cajeroInsertarTarjeta('${j.uid}')">
        <div class="tarjeta-header">
          <div class="chip"></div>
        </div>
        <div>
          <div class="t-nombre">${j.nombre}</div>
        </div>
      </div>`;
  });
  cajeroActualizarRanuras();

  // 2. Llenar la lista desplegable de Transferir Host
  const candidatosHost = jugadoresArray.filter((j) => j.uid !== state.uid);
  _reconstruirSelect('select-nuevo-host', candidatosHost, false);

  const btnTransferir = document.getElementById('btn-transferir-host');
  if (btnTransferir) {
    btnTransferir.disabled = candidatosHost.length === 0;
  }
}

function cajeroActualizarRanuras() {
  const insIzq = document.getElementById('ins-izq');
  const insDer = document.getElementById('ins-der');
  
  const jIzq = state.cajero.uidIzq ? state.jugadores[state.cajero.uidIzq] : null;
  const jDer = state.cajero.uidDer ? state.jugadores[state.cajero.uidDer] : null;

  insIzq.innerHTML = jIzq ? `<div class="mini-card" style="background:${getColorHex(jIzq.color)}" onclick="cajeroQuitarTarjeta('izq', event)">${jIzq.nombre}<small>Quitar</small></div>` : '';
  insDer.innerHTML = jDer ? `<div class="mini-card" style="background:${getColorHex(jDer.color)}" onclick="cajeroQuitarTarjeta('der', event)">${jDer.nombre}<small>Quitar</small></div>` : '';
  
  document.getElementById('slot-izq').classList.toggle('active-izq', state.cajero.ranuraActiva === 'izq');
  document.getElementById('slot-der').classList.toggle('active-der', state.cajero.ranuraActiva === 'der');
}

function cajeroSeleccionarRanura(lado) {
  state.cajero.ranuraActiva = lado;
  cajeroActualizarRanuras();
}

function cajeroInsertarTarjeta(uid) {
  if (state.cajero.ranuraActiva === 'izq') state.cajero.uidIzq = uid;
  if (state.cajero.ranuraActiva === 'der') state.cajero.uidDer = uid;
  
  if (state.cajero.ranuraActiva === 'izq' && !state.cajero.uidDer) state.cajero.ranuraActiva = 'der';
  else if (state.cajero.ranuraActiva === 'der' && !state.cajero.uidIzq) state.cajero.ranuraActiva = 'izq';
  
  renderCajero();
}

function cajeroQuitarTarjeta(lado, e) {
  e.stopPropagation();
  if (lado === 'izq') state.cajero.uidIzq = null;
  if (lado === 'der') state.cajero.uidDer = null;
  state.cajero.ranuraActiva = lado;
  renderCajero();
}

// Lógica del teclado
function cajeroInput(num) {
  if (state.cajero.entradaTxt.includes('.') && num === '.') return;
  if (state.cajero.entradaTxt.length > 6) return; 
  state.cajero.entradaTxt += num;
  document.getElementById('cajero-display').innerText = state.cajero.entradaTxt;
}

function cajeroMultiplicador(mult) {
  if (!state.cajero.entradaTxt) return;
  let valor = parseFloat(state.cajero.entradaTxt);
  state.cajero.montoPendiente = mult === 'M' ? valor * 1000000 : valor * 1000;
  
  const display = document.getElementById('cajero-display');
  display.innerText = formatMonto(state.cajero.montoPendiente);
  display.style.color = "#f59e0b";
  document.getElementById('cajero-status').innerText = "CONFIRME:";
  document.getElementById('btn-confirmar-cajero').classList.remove('disabled');
}

function cajeroLimpiar() {
  state.cajero.entradaTxt = '';
  state.cajero.montoPendiente = 0;
  const display = document.getElementById('cajero-display');
  display.innerText = '0';
  display.style.color = "#10b981";
  document.getElementById('cajero-status').innerText = "Monto a transferir:";
  document.getElementById('btn-confirmar-cajero').classList.add('disabled');
}

// Conexión con Firebase
async function cajeroConfirmar() {
  if (state.cajero.montoPendiente === 0) return;
  if (!state.cajero.uidIzq && !state.cajero.uidDer) {
    mostrarToast("Falta colocar una tarjeta", "error");
    return;
  }

  // Firebase necesita: origenVal (quien paga/DER), destinoVal (quien recibe/IZQ), monto
  const origenVal = state.cajero.uidDer || '';
  const destinoVal = state.cajero.uidIzq || '';
  
  await ejecutarTransaccionConDatos(origenVal, destinoVal, state.cajero.montoPendiente, 'Desde terminal');
  cajeroLimpiar();
}

async function cajeroPasoSalida() {
  if (!state.cajero.uidIzq) {
    mostrarToast("Colocá la tarjeta en Recibe (+) para cobrar el GO", "warning");
    return;
  }
  // Banco paga 2M al jugador en la ranura izquierda
  await ejecutarTransaccionConDatos('', state.cajero.uidIzq, 2000000, 'Paso por GO');
}

// Exponer las nuevas funciones a window para que los botones HTML funcionen
Object.assign(window, {
  cajeroSeleccionarRanura, cajeroInput, cajeroMultiplicador, 
  cajeroLimpiar, cajeroConfirmar, cajeroPasoSalida, 
  cajeroInsertarTarjeta, cajeroQuitarTarjeta
});

/* ══════════════════════════════════════════════════════════════
   5. RENDER HISTORIAL MAESTRO
══════════════════════════════════════════════════════════════ */

/**
 * Renderiza TODAS las transacciones de la sala ordenadas de más
 * reciente a más antigua en #historial-maestro (o #cajero-historial).
 */
function renderHistorialMaestro() {
  const contenedor = document.getElementById('historial-maestro')
                  ?? document.getElementById('cajero-historial');
  const elVacio    = document.getElementById('cajero-historial-vacio');
  if (!contenedor) return;

  // ── Ordenar todas las transacciones ─────────────────────────
  const todas = state.transacciones
    .slice()
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

  // ── Estado vacío ─────────────────────────────────────────────
  if (todas.length === 0) {
    contenedor.innerHTML = '';
    if (elVacio) {
      elVacio.hidden = false;
    } else {
      contenedor.innerHTML = `<li class="history__empty">Sin transacciones aún.</li>`;
    }
    return;
  }

  if (elVacio) elVacio.hidden = true;

  // ── Renderizar ───────────────────────────────────────────────
  contenedor.innerHTML = '';

  todas.forEach((tx) => {
    const nombreOrigen  = _resolverNombreJugador(tx.origenUid);
    const nombreDestino = _resolverNombreJugador(tx.destinoUid);
    const fechaStr      = tx.timestamp ? _formatearFechaCorta(tx.timestamp) : '';

    // El maestro muestra siempre verde (cobro al destino) desde el
    // punto de vista del flujo de dinero, no del jugador local
    const esEgresoBanco  = !tx.origenUid;   // el banco paga → verde
    const tipoClase      = esEgresoBanco || tx.destinoUid ? 'tx-ingreso' : 'tx-egreso';

    // Nota
    const notaHTML = tx.nota
      ? `<span class="tx-item__nota">${_escaparHTML(tx.nota)}</span>`
      : '';

    const li = document.createElement('li');
    li.className = `tx-item ${tipoClase}`;
    li.innerHTML = `
      <div class="tx-item__icon" aria-hidden="true">⇄</div>
      <div class="tx-item__body">
        <span class="tx-item__desc">
          <strong>${_escaparHTML(nombreOrigen)}</strong>
          <span class="tx-item__arrow" aria-hidden="true"> → </span>
          <strong>${_escaparHTML(nombreDestino)}</strong>
        </span>
        ${notaHTML}
        <span class="tx-item__meta">${fechaStr}</span>
      </div>
      <span class="tx-item__amount">${formatMonto(tx.monto)}</span>
    `;
    contenedor.appendChild(li);
  });
}

/* ══════════════════════════════════════════════════════════════
   HELPERS INTERNOS DE RENDER
══════════════════════════════════════════════════════════════ */

/**
 * Reconstruye un <select> preservando la selección anterior.
 * Las opciones se construyen a partir del array de jugadores dado;
 * cada jugador obtiene un emoji de color como prefijo visual.
 *
 * @param {string}   selectId       - ID del elemento <select>
 * @param {Array}    jugadores      - Array de objetos jugador (puede incluir banco)
 * @param {boolean}  [incluirBanco] - No usado aquí; el banco viene dentro del array
 */
function _reconstruirSelect(selectId, jugadores) {
  const select = document.getElementById(selectId);
  if (!select) return;

  // Guardar selección anterior
  const valorAnterior = select.value;

  select.innerHTML = '';

  jugadores.forEach((jugador) => {
    const option = document.createElement('option');
    option.value = jugador.uid ?? '';

    if (jugador._esBanco) {
      option.textContent = '🏦 Banco';
    } else {
      const emoji = getColorEmoji(jugador.color);
      const esYo  = jugador.uid === state.uid ? ' (vos)' : '';
      option.textContent = `${emoji} ${jugador.nombre}${esYo}`;
    }

    select.appendChild(option);
  });

  // Restaurar selección si el valor sigue siendo válido
  const valoresValidos = Array.from(select.options).map((o) => o.value);
  if (valoresValidos.includes(valorAnterior)) {
    select.value = valorAnterior;
  }
}

/**
 * Resuelve el nombre para mostrar de un participante de una transacción.
 * Si uid es null / undefined / '' → "🏦 Banco".
 * Si el jugador ya no está en state.jugadores → "Jugador desconectado".
 *
 * @param {string|null|undefined} uid
 * @returns {string}
 */
function _resolverNombreJugador(uid) {
  if (!uid) return '🏦 Banco';
  const jugador = state.jugadores[uid];
  if (!jugador) return 'Jugador desconectado';
  return jugador.nombre;
}

/**
 * Formatea un timestamp Unix (ms) como cadena corta legible.
 * Hoy: muestra solo la hora ("14:32").
 * Otro día: muestra día y mes ("12 jun").
 *
 * @param {number} timestamp - Milisegundos desde epoch
 * @returns {string}
 */
function _formatearFechaCorta(timestamp) {
  const fecha  = new Date(timestamp);
  const ahora  = new Date();
  const esHoy  =
    fecha.getFullYear() === ahora.getFullYear() &&
    fecha.getMonth()    === ahora.getMonth()    &&
    fecha.getDate()     === ahora.getDate();

  if (esHoy) {
    return fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  }

  return fecha.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
}

/**
 * Oscurece un color hexadecimal multiplicando cada canal RGB
 * por el factor dado (0–1).
 *
 * @param {string} hex    - Color en formato "#RRGGBB"
 * @param {number} factor - Factor de oscurecimiento (ej: 0.55)
 * @returns {string}      - Color resultante en formato "rgb(r, g, b)"
 */
function _hexADimmer(hex, factor) {
  const limpio = hex.replace('#', '');
  const r      = Math.round(parseInt(limpio.slice(0, 2), 16) * factor);
  const g      = Math.round(parseInt(limpio.slice(2, 4), 16) * factor);
  const b      = Math.round(parseInt(limpio.slice(4, 6), 16) * factor);
  return `rgb(${r}, ${g}, ${b})`;
}

// ── Actualizar stubs de Parte 2 con implementaciones reales ──

/**
 * Reemplaza el stub de Parte 2: actualiza la billetera cuando
 * el listener de jugadores detecta un cambio de saldo.
 * (Redefinición intencional: sobreescribe la función vacía anterior.)
 */
function _actualizarBilletera() {       // eslint-disable-line no-redeclare
  if (state.modoActual === 'billetera') {
    renderBilletera();
  }
}

/**
 * Reemplaza el stub de Parte 2: reconstruye los selects del cajero
 * cuando cambia la lista de jugadores.
 */
function _renderizarSelectorJugadores() {   // eslint-disable-line no-redeclare
  if (state.modoActual === 'cajero') {
    renderCajero();
  }
}

/**
 * Reemplaza el stub de Parte 2: re-renderiza el historial personal
 * cuando llegan nuevas transacciones.
 */
function _renderizarHistorialPersonal() {   // eslint-disable-line no-redeclare
  if (state.modoActual === 'billetera') {
    renderHistorialPersonal();
  }
}

/**
 * Reemplaza el stub de Parte 2: re-renderiza el historial maestro
 * cuando llegan nuevas transacciones.
 */
function _renderizarHistorialMaestro() {    // eslint-disable-line no-redeclare
  if (state.modoActual === 'cajero') {
    renderHistorialMaestro();
  }
}

// [CONTINÚA EN PARTE 4]

/* ═══════════════════════════════════════════════════════════════
   NEOBANKER — app.js  |  PARTE 4 (final): Transacciones y eventos
   ═══════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════
   1. EJECUTAR TRANSACCIÓN (punto de entrada desde el formulario)
══════════════════════════════════════════════════════════════ */

/**
 * Lee y valida el formulario de transacción del cajero.
 * Si el origen no tiene fondos suficientes, bifurca según modoEstricto:
 *   - Estricto → error inline, no procede.
 *   - Flexible → guarda en state.pendingTx y abre el modal de confirmación.
 * Si todo está bien, delega en ejecutarTransaccionConDatos().
 *
 * @returns {Promise<void>}
 */
async function ejecutarTransaccion() {
// ── Leer formulario ──────────────────────────────────────────
  const origenVal  = document.getElementById('tx-jugador-origen')?.value  ?? '';
  const destinoVal = document.getElementById('tx-jugador-destino')?.value ?? '';
  const montoRaw   = document.getElementById('tx-monto')?.value   ?? '';
  const nota       = document.getElementById('tx-descripcion')?.value.trim() ?? '';

  const monto = parseMonto(montoRaw);

  // ── Validación básica ────────────────────────────────────────
  if (!monto || monto <= 0 || !Number.isFinite(monto)) {
    showError('hint-tx-monto', 'Ingresá un monto mayor a cero.');
    return;
  }
  hideError('hint-tx-monto');

  if (origenVal !== '' && origenVal === destinoVal) {
    showError('hint-tx-monto', 'El origen y el destino no pueden ser el mismo.');
    return;
  }

  // ── Verificar fondos si el origen es un jugador ──────────────
  if (origenVal !== '') {
    const jugadorOrigen = state.jugadores[origenVal];

    if (!jugadorOrigen) {
      mostrarToast('El jugador de origen ya no está en la sala.', 'error');
      return;
    }

    const saldoActual = jugadorOrigen.saldo ?? 0;

    if (saldoActual < monto) {
      if (state.meta?.modoEstricto) {
        // ── Modo estricto: bloquear ──────────────────────────
        showError(
          'hint-tx-monto',
          `${_escaparHTML(jugadorOrigen.nombre)} solo tiene ${formatMonto(saldoActual)}.`,
        );
        return;
      }

      // ── Modo flexible: confirmar vía modal ───────────────────
      state.pendingTx = { origenVal, destinoVal, monto, nota };

      const saldoResultante = saldoActual - monto;

      const elTexto = document.getElementById('modal-fondos-texto')
                   ?? document.getElementById('modal-fondos-body');
      if (elTexto) {
        const nombreDestino = destinoVal
          ? _resolverNombreJugador(destinoVal)
          : '🏦 Banco';
        elTexto.innerHTML = `
          <strong>${_escaparHTML(jugadorOrigen.nombre)}</strong> quiere pagar
          <strong>${formatMonto(monto)}</strong> a
          <strong>${_escaparHTML(nombreDestino)}</strong>.<br><br>
          Saldo actual: <strong>${formatMonto(saldoActual)}</strong><br>
          Saldo resultante: <strong style="color:var(--danger)">${formatMonto(saldoResultante)}</strong>
        `;
      }

      const modal = document.getElementById('modal-fondos');
      if (modal) modal.hidden = false;

      return;   // Espera la decisión del usuario en el modal
    }
  }

  // ── Fondos suficientes (o banco como origen): ejecutar ───────
  await ejecutarTransaccionConDatos(origenVal, destinoVal, monto, nota);
}

/* ══════════════════════════════════════════════════════════════
   2. EJECUTAR TRANSACCIÓN FORZADA (desde modal fondos insuficientes)
══════════════════════════════════════════════════════════════ */

/**
 * Se llama cuando el host confirma proceder a pesar de fondos insuficientes.
 * Cierra el modal, recupera state.pendingTx y delega en ejecutarTransaccionConDatos().
 *
 * @returns {Promise<void>}
 */
async function ejecutarTransaccionForced() {
  cerrarModal('modal-fondos');

  const tx = state.pendingTx;
  state.pendingTx = null;

  if (!tx) {
    console.warn('[ejecutarTransaccionForced] No hay pendingTx.');
    return;
  }

  await ejecutarTransaccionConDatos(tx.origenVal, tx.destinoVal, tx.monto, tx.nota);
}

/* ══════════════════════════════════════════════════════════════
   3. EJECUTAR TRANSACCIÓN CON DATOS (escritura atómica)
══════════════════════════════════════════════════════════════ */

/**
 * Realiza la escritura multi-ruta en Firebase de forma atómica:
 * registra la transacción, ajusta los saldos de origen y destino
 * y actualiza la marca de actividad de la sala en un único update().
 *
 * @param {string} origenVal   - UID del jugador origen, o '' para el banco
 * @param {string} destinoVal  - UID del jugador destino, o '' para el banco
 * @param {number} monto       - Monto positivo de la transacción
 * @param {string} [nota='']   - Nota libre opcional
 * @returns {Promise<void>}
 */
async function ejecutarTransaccionConDatos(origenVal, destinoVal, monto, nota = '') {
  const codigo = state.codigoSala;
  if (!codigo) return;

  mostrarLoading(true);

  try {
    // ── Determinar tipo ──────────────────────────────────────
    let tipo;
    if (!origenVal && destinoVal)       tipo = 'banco-a-jugador';
    else if (origenVal && !destinoVal)  tipo = 'jugador-a-banco';
    else                                tipo = 'jugador-a-jugador';

    // ── Generar key única sin escribir aún ───────────────────
    const txKey  = push(ref(db, `salas/${codigo}/transacciones`)).key;
    const ahora  = Date.now();

    // ── Construir objeto de updates multi-ruta ───────────────
    const updates = {};

    // Transacción
    updates[`salas/${codigo}/transacciones/${txKey}`] = {
      tipo,
      origenUid:  origenVal  || null,
      destinoUid: destinoVal || null,
      monto,
      timestamp:  ahora,
      nota:       nota || null,
    };

    // Saldo del origen (si es jugador)
    if (origenVal) {
      const saldoOrigen = state.jugadores[origenVal]?.saldo ?? 0;
      updates[`salas/${codigo}/jugadores/${origenVal}/saldo`] = saldoOrigen - monto;
    }

    // Saldo del destino (si es jugador)
    if (destinoVal) {
      const saldoDestino = state.jugadores[destinoVal]?.saldo ?? 0;
      updates[`salas/${codigo}/jugadores/${destinoVal}/saldo`] = saldoDestino + monto;
    }

    // Marca de actividad
    updates[`salas/${codigo}/meta/ultimaActividadEn`] = ahora;

    // ── Escritura atómica ────────────────────────────────────
    await update(ref(db), updates);

    // ── Limpiar formulario ───────────────────────────────────
    const elMonto = document.getElementById('cajero-monto');
    const elNota  = document.getElementById('cajero-nota');
    if (elMonto) elMonto.value = '';
    if (elNota)  elNota.value  = '';
    hideError('hint-tx-monto');

    // ── Feedback ─────────────────────────────────────────────
    const nombreOrigen  = origenVal  ? _resolverNombreJugador(origenVal)  : '🏦 Banco';
    const nombreDestino = destinoVal ? _resolverNombreJugador(destinoVal) : '🏦 Banco';
    mostrarToast(
      `${formatMonto(monto)} de ${nombreOrigen} → ${nombreDestino}`,
      'success',
    );

  } catch (err) {
    console.error('[ejecutarTransaccionConDatos]', err);
    mostrarToast('Error al registrar la transacción. Intentá de nuevo.', 'error');
  } finally {
    mostrarLoading(false);
  }
}

/* ══════════════════════════════════════════════════════════════
   4. TRANSFERIR HOST
══════════════════════════════════════════════════════════════ */

/**
 * Transfiere el rol de host a otro jugador de la sala.
 * Pide confirmación nativa antes de escribir en Firebase.
 *
 * @returns {Promise<void>}
 */
async function transferirHost() {
  const select     = document.getElementById('cajero-transfer-host')
                  ?? document.getElementById('select-nuevo-host');
  const nuevoUid   = select?.value ?? '';

  if (!nuevoUid) {
    mostrarToast('Seleccioná un jugador para transferirle el rol.', 'warning');
    return;
  }

  const jugadorDestino = state.jugadores[nuevoUid];
  if (!jugadorDestino) {
    mostrarToast('Ese jugador ya no está en la sala.', 'error');
    return;
  }

  // Confirmación nativa (sin modal extra para no complicar el flujo)
  const confirmar = window.confirm(
    `¿Transferir el rol de host a ${jugadorDestino.nombre}?\n` +
    'Perderás el acceso al panel de cajero.',
  );
  if (!confirmar) return;

  mostrarLoading(true);
  try {
    await update(ref(db, `salas/${state.codigoSala}/meta`), {
      hostUid:           nuevoUid,
      ultimaActividadEn: Date.now(),
    });

    state.esHost = false;
    mostrarToast(`${jugadorDestino.nombre} ahora es el host.`, 'success');

    // Cambiar a modo billetera: ya no tiene acceso al cajero
    activarModo('billetera');

  } catch (err) {
    console.error('[transferirHost]', err);
    mostrarToast('No se pudo transferir el host. Intentá de nuevo.', 'error');
  } finally {
    mostrarLoading(false);
  }
}

/* ══════════════════════════════════════════════════════════════
   5. MOSTRAR MODAL CONFIRMAR TERMINAR
══════════════════════════════════════════════════════════════ */

/**
 * Abre el modal de confirmación para terminar la partida.
 * Solo el host debería poder llamar esta función, pero se
 * añade un guard por si acaso.
 */
function mostrarConfirmTerminar() {
  if (!state.esHost) return;
  const modal = document.getElementById('modal-terminar');
  if (modal) modal.hidden = false;
}

/* ══════════════════════════════════════════════════════════════
   6. TERMINAR PARTIDA
══════════════════════════════════════════════════════════════ */

/**
 * Elimina el nodo de la sala de Firebase.
 * El listener de meta detectará la ausencia del nodo y llamará
 * salirDeSala() en todos los clientes conectados.
 *
 * @returns {Promise<void>}
 */
/**
 * Marca la partida como terminada.
 * El listener de meta lo detectará y llamará salirDeSala() 
 * en todos los clientes conectados.
 */
async function terminarPartida() {
  cerrarModal('modal-terminar');
  if (!state.esHost || !state.codigoSala) return;

  mostrarLoading(true);
  try {
    // Ahora sí eliminamos el nodo completo de la base de datos
    await remove(ref(db, `salas/${state.codigoSala}`));
    
    _limpiarSesionLocal();
    salirDeSala();
    mostrarToast('Partida finalizada y datos eliminados.', 'info');
  } catch (err) {
    console.error('[terminarPartida]', err);
    mostrarToast('Error al cerrar la sala.', 'error');
  } finally {
    mostrarLoading(false);
  }
}

/* ══════════════════════════════════════════════════════════════
   UTILIDAD: CERRAR MODAL
══════════════════════════════════════════════════════════════ */

/**
 * Oculta un modal por su ID añadiendo `hidden`.
 * Usado por los botones "Cancelar" de ambos modales.
 *
 * @param {string} modalId
 */
function cerrarModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.hidden = true;
}

/* ══════════════════════════════════════════════════════════════
   WIRING DE EVENTOS (al cargar el DOM)
══════════════════════════════════════════════════════════════ */

/**
 * Registra todos los event listeners del HTML de forma programática.
 * Se llama una sola vez cuando el DOM está listo.
 * Centralizar aquí evita onclick= en el HTML y mantiene el JS como
 * única fuente de verdad para la interacción.
 */
function _wireEvents() {
  // ── Home ─────────────────────────────────────────────────────
  _on('btn-crear-sala',    'click', () => {
    renderColorPicker(
      'color-picker-host',
      (id) => { state.colorSeleccionado.host = id; },
    );
    mostrarPantalla('screen-crear');
  });

  _on('btn-unirse-sala',   'click', () => mostrarPantalla('screen-unirse'));

  // ── Botones volver ───────────────────────────────────────────
  _on('back-crear',   'click', () => mostrarPantalla('screen-home'));
  _on('back-unirse',  'click', () => mostrarPantalla('screen-home'));
  _on('back-perfil',  'click', () => mostrarPantalla('screen-unirse'));

  // ── Crear sala ───────────────────────────────────────────────
  _on('form-crear',            'submit', (e) => { e.preventDefault(); crearSala(); });
  _on('btn-crear-confirmar',   'click',  crearSala);

  // ── Unirse a sala ────────────────────────────────────────────
  _on('form-unirse',           'submit', (e) => { e.preventDefault(); buscarSala(); });
  _on('btn-unirse-confirmar',  'click',  buscarSala);

  // ── Perfil ───────────────────────────────────────────────────
  _on('form-perfil',           'submit', (e) => { e.preventDefault(); unirseASala(); });

  // Preview de avatar en tiempo real mientras se escribe el nombre
  _on('input-nombre-jugador', 'input', (e) => {
    const inicial   = e.target.value.trim().charAt(0).toUpperCase();
    const elInicial = document.getElementById('avatar-preview-inicial');
    if (elInicial) elInicial.textContent = inicial || '?';
  });

  // ── Lobby ────────────────────────────────────────────────────
  _on('btn-iniciar-partida', 'click', iniciarPartida);
  _on('btn-copiar-codigo',   'click', _copiarCodigoSala);

  // ── Billetera ────────────────────────────────────────────────
  _on('btn-ir-cajero',      'click', () => activarModo('cajero'));
  _on('btn-toggle-cajero',  'click', () => activarModo('cajero'));   // alias

  // ── Cajero ───────────────────────────────────────────────────
  _on('btn-ir-billetera',         'click', () => activarModo('billetera'));
  _on('form-transaccion',         'submit', (e) => { e.preventDefault(); ejecutarTransaccion(); });
  _on('btn-transferir-host',      'click',  transferirHost);
  _on('btn-terminar-partida',     'click',  mostrarConfirmTerminar);
  _on('btn-limpiar-historial',    'click',  _confirmarLimpiarHistorial);

  // Segmented control del tipo de transacción
  document.querySelectorAll('.segmented__option').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segmented__option').forEach((b) => {
        b.classList.remove('segmented__option--active');
      });
      btn.classList.add('segmented__option--active');

      const hiddenInput = document.getElementById('tx-tipo');
      if (hiddenInput) hiddenInput.value = btn.dataset.value ?? '';

      // Ajustar visibilidad de selects según tipo
      _actualizarVisibilidadSelectsTx(btn.dataset.value);
    });
  });

  // ── Modales ──────────────────────────────────────────────────
  _on('modal-fondos-cancelar',   'click', () => {
    cerrarModal('modal-fondos');
    state.pendingTx = null;
  });
  _on('modal-fondos-confirmar',  'click',  ejecutarTransaccionForced);
  _on('modal-terminar-cancelar', 'click', () => cerrarModal('modal-terminar'));
  _on('modal-terminar-confirmar','click',  terminarPartida);

  // Cerrar modales al hacer click en el backdrop
  ['modal-fondos', 'modal-terminar'].forEach((id) => {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.classList.contains('modal__backdrop')) {
        cerrarModal(id);
        if (id === 'modal-fondos') state.pendingTx = null;
      }
    });
  });

  // Cerrar modales con Escape
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    cerrarModal('modal-fondos');
    cerrarModal('modal-terminar');
    state.pendingTx = null;
  });
}

/* ══════════════════════════════════════════════════════════════
   HELPERS INTERNOS DE ESTA PARTE
══════════════════════════════════════════════════════════════ */

/**
 * Atajo para addEventListener con ID. No lanza error si el elemento
 * no existe (pantallas que se renderizan condicionalmente).
 *
 * @param {string}   id
 * @param {string}   evento
 * @param {Function} handler
 */
function _on(id, evento, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evento, handler);
}

/**
 * Copia el código de sala al portapapeles y muestra un toast de confirmación.
 */
async function _copiarCodigoSala() {
  const codigo = state.codigoSala;
  if (!codigo) return;
  try {
    await navigator.clipboard.writeText(codigo);
    mostrarToast(`Código ${codigo} copiado al portapapeles.`, 'success');
  } catch {
    // Fallback para navegadores sin Clipboard API (ej: HTTP sin HTTPS)
    mostrarToast(`Código de sala: ${codigo}`, 'info');
  }
}

/**
 * Muestra/oculta los selects "De" y "Para" según el tipo de transacción
 * para guiar mejor al cajero:
 *   - cobrar:    banco → jugador  (origen fijo = banco, se oculta el select origen)
 *   - pagar:     jugador → banco  (destino fijo = banco, se oculta el select destino)
 *   - transferir: jugador → jugador (ambos selects visibles)
 *
 * @param {string} tipo  'cobrar' | 'pagar' | 'transferir'
 */
function _actualizarVisibilidadSelectsTx(tipo) {
  const grupoOrigen  = document.getElementById('cajero-origen')?.closest('.form__group');
  const grupoDestino = document.getElementById('cajero-destino')?.closest('.form__group');
  if (!grupoOrigen || !grupoDestino) return;

  const selectOrigen  = document.getElementById('cajero-origen');
  const selectDestino = document.getElementById('cajero-destino');

  if (tipo === 'cobrar') {
    // El banco paga al jugador → origen siempre = banco
    grupoOrigen.hidden = true;
    grupoDestino.hidden = false;
    if (selectOrigen) selectOrigen.value = '';    // '' = banco
  } else if (tipo === 'pagar') {
    // El jugador paga al banco → destino siempre = banco
    grupoOrigen.hidden = false;
    grupoDestino.hidden = true;
    if (selectDestino) selectDestino.value = '';  // '' = banco
  } else {
    // Transferencia entre jugadores → ambos visibles
    grupoOrigen.hidden  = false;
    grupoDestino.hidden = false;
  }
}

/**
 * Pide confirmación antes de limpiar el historial maestro visualmente.
 * No elimina datos de Firebase; solo limpia el render local (el listener
 * los volverá a mostrar si la pantalla se recarga).
 *
 * Nota: si se desea eliminar el historial de Firebase permanentemente,
 * reemplazar el cuerpo con remove(ref(db, `salas/${state.codigoSala}/transacciones`)).
 */
async function _confirmarLimpiarHistorial() {
  if (!window.confirm('¿Borrar TODO el historial de transacciones de la base de datos?\n(Esto no se puede deshacer)')) return;
  
  mostrarLoading(true);
  try {
    // Borramos el nodo de transacciones en Firebase
    await remove(ref(db, `salas/${state.codigoSala}/transacciones`));
    
    // El listener onValue detectará el cambio y limpiará la pantalla automáticamente
    mostrarToast('Historial borrado.', 'success');
  } catch (err) {
    console.error('[LimpiarHistorial]', err);
    mostrarToast('No tienes permisos para borrar el historial.', 'error');
  } finally {
    mostrarLoading(false);
  }
}

/* ══════════════════════════════════════════════════════════════
   7. EXPOSICIÓN EN window (para compatibilidad con onclick= en HTML
      y acceso desde la consola en desarrollo)
══════════════════════════════════════════════════════════════ */

Object.assign(window, {
  // Navegación
  mostrarPantalla,

  // Flujo de sala
  crearSala,
  buscarSala,
  unirseASala,
  iniciarPartida,

  // Modos de pantalla
  activarModo,

  // Transacciones
  ejecutarTransaccion,
  ejecutarTransaccionForced,

  // Administración de sala
  transferirHost,
  mostrarConfirmTerminar,
  terminarPartida,

  // Modales
  cerrarModal,
});

/* ══════════════════════════════════════════════════════════════
   ARRANQUE DEL WIRING (espera a que el DOM esté listo)
══════════════════════════════════════════════════════════════ */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _wireEvents);
} else {
  // El script se cargó después de que el DOM ya estaba listo
  _wireEvents();
}