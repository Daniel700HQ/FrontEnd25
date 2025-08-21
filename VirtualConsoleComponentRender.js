// VirtualConsoleComponentRender.js

// Almacenamos las funciones originales de la consola del VENTANA PRINCIPAL
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

// BUFFER para almacenar mensajes antes de que el textarea esté listo
const consoleMessageBuffer = [];

// Variable global para apuntar a la función de renderizado en tiempo real.
let activeConsoleAppender = null;

// --- Redirige las funciones de la consola NATURAMENTE, tan pronto como este script se ejecuta ---
console.log = (...args) => {
    const timestamp = new Date().toLocaleTimeString();
    const formattedMessage = formatConsoleMessage(args);
    const messageEntry = { timestamp, type: 'LOG', message: formattedMessage };

    // Si el componente ya está activo, añade el mensaje directamente.
    // Si no, lo guarda en el buffer.
    if (activeConsoleAppender) {
        activeConsoleAppender(messageEntry.message, messageEntry.type, messageEntry.timestamp);
    } else {
        consoleMessageBuffer.push(messageEntry);
    }
    originalLog.apply(console, args); // Llamar a la función original también
};

console.warn = (...args) => {
    const timestamp = new Date().toLocaleTimeString();
    const formattedMessage = formatConsoleMessage(args);
    const messageEntry = { timestamp, type: 'WARN', message: formattedMessage };

    // Lógica de renderizado en tiempo real / buffer
    if (activeConsoleAppender) {
        activeConsoleAppender(messageEntry.message, messageEntry.type, messageEntry.timestamp);
    } else {
        consoleMessageBuffer.push(messageEntry);
    }
    originalWarn.apply(console, args);
};

console.error = (...args) => {
    const timestamp = new Date().toLocaleTimeString();
    const formattedMessage = formatConsoleMessage(args);
    const messageEntry = { timestamp, type: 'ERROR', message: formattedMessage };

    // Lógica de renderizado en tiempo real / buffer
    if (activeConsoleAppender) {
        activeConsoleAppender(messageEntry.message, messageEntry.type, messageEntry.timestamp);
    } else {
        consoleMessageBuffer.push(messageEntry);
    }
    originalError.apply(console, args);
};

/**
 * Formatea los argumentos pasados a console.* en una cadena de texto.
 * Se mueve fuera de la clase para poder ser usado por la redirección temprana.
 * @param {Array} args - Argumentos pasados a la función de la consola.
 * @returns {string} - Mensaje formateado.
 */
function formatConsoleMessage(args) {
    return args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
            try {
                return JSON.stringify(arg, null, 2); // Formatea objetos para legibilidad
            } catch (e) {
                return String(arg); // Si falla JSON.stringify (ej. ciclos circulares), usa String()
            }
        }
        return String(arg);
    }).join(' ');
}

class VirtualConsoleComponent extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' }); // Abre el Shadow DOM
        this.textarea = null; // Para almacenar la referencia al textarea de salida
        this.inputElement = null; // Para almacenar la referencia al input de entrada
        this.consoleDisplay = null; // Referencia al contenedor de la consola completa
        this.showButton = null; // Referencia al botón para mostrar la consola
        this.hideButton = null; // Referencia al botón para ocultar la consola
        this.consoleIframe = null; // Referencia al iframe
        this.iframeWindow = null; // Referencia al objeto window del iframe

        // --- Claves de localStorage ---
        this.WIDTH_KEY = 'virtualConsoleWidth';
        this.HEIGHT_KEY = 'virtualConsoleHeight';
        this.VISIBLE_KEY = 'virtualConsoleVisible';
        this.HISTORY_KEY = 'virtualConsoleHistory';

        // --- Estado inicial desde localStorage o valores por defecto ---
        this.isConsoleVisible = this.getLocalStorageItem(this.VISIBLE_KEY, 'true') === 'true';
        this.lastKnownWidth = this.getLocalStorageItem(this.WIDTH_KEY, '80vw');
        this.lastKnownHeight = this.getLocalStorageItem(this.HEIGHT_KEY, '25vh');

        // --- Historial de comandos ingresados (para flechas arriba/abajo) ---
        try {
            this.inputHistory = JSON.parse(this.getLocalStorageItem(this.HISTORY_KEY, '[]'));
        } catch (e) {
            originalError("Error al cargar el historial de la consola:", e);
            this.inputHistory = [];
        }
        this.historyIndex = this.inputHistory.length;

        // --- CÓDIGO CLAVE PARA PERSISTENCIA DE VARIABLES ---
        this.cumulativeExecutedCode = '';

        this.resizeObserver = null;
        this.debouncedSaveSize = this.debounce(this.saveConsoleSize.bind(this), 500);
    }

    async connectedCallback() {
        // Carga la plantilla HTML del componente
        const response = await fetch('VirtualConsoleComponent.html');
        const html = await response.text();
        this.shadowRoot.innerHTML = html;

        // Obtiene referencias a los elementos del Shadow DOM
        this.textarea = this.shadowRoot.querySelector('#consoleOutput');
        this.inputElement = this.shadowRoot.querySelector('#consoleInput');
        const clearButton = this.shadowRoot.querySelector('#clearButton');
        this.hideButton = this.shadowRoot.querySelector('#hideButton');
        this.showButton = this.shadowRoot.querySelector('#showButton');
        this.consoleDisplay = this.shadowRoot.querySelector('#consoleDisplay');
        this.consoleIframe = this.shadowRoot.querySelector('#consoleIframe');

        // --- Aplica el tamaño y la visibilidad guardados ---
        if (this.consoleDisplay) {
            this.consoleDisplay.style.width = this.lastKnownWidth;
            this.consoleDisplay.style.height = this.lastKnownHeight;
        }

        // --- Configura ResizeObserver para guardar el tamaño al redimensionar ---
        if (this.consoleDisplay) {
            this.resizeObserver = new ResizeObserver(entries => {
                this.debouncedSaveSize();
            });
            this.resizeObserver.observe(this.consoleDisplay);
        }

        // --- Configura el iframe y su contexto de consola ---
        await this.setupIframeContext();

        // Asigna eventos
        if (clearButton) {
            clearButton.addEventListener('click', () => this.clearConsole());
        }
        if (this.hideButton) {
            this.hideButton.addEventListener('click', () => this.hideConsole());
        }
        if (this.showButton) {
            this.showButton.addEventListener('click', () => this.showConsole());
        }
        if (this.inputElement) {
            this.inputElement.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    this.processInput(this.inputElement.value);
                    this.inputElement.value = '';
                    this.historyIndex = this.inputHistory.length;
                } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    this.navigateHistory(-1);
                } else if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    this.navigateHistory(1);
                }
            });

            this.inputElement.addEventListener('input', () => {
                if (this.historyIndex !== this.inputHistory.length && this.inputElement.value !== this.inputHistory[this.historyIndex]) {
                    this.historyIndex = this.inputHistory.length;
                }
            });
        }
        
        // Registra la función de este componente como el "appender" activo.
        // Se usa .bind(this) para asegurar que el contexto de 'this' sea correcto.
        activeConsoleAppender = this.appendMessage.bind(this);

        // --- Vacía el buffer de mensajes que se acumularon antes de que el componente estuviera listo ---
        this.flushMessageBuffer();

        // Establece el estado inicial de visibilidad después de cargar todo
        this.updateVisibility();
    }

    // --- Ciclo de vida: Cuando el componente es removido del DOM ---
    disconnectedCallback() {
        // Desconecta el ResizeObserver para evitar fugas de memoria
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        // Limpia el "appender" global si este componente se elimina del DOM.
        if (activeConsoleAppender === this.appendMessage.bind(this)) {
            activeConsoleAppender = null;
        }
    }

    /**
     * Navega por el historial de comandos usando las flechas arriba/abajo.
     * @param {number} direction - -1 para arriba (anterior), 1 para abajo (siguiente).
     */
    navigateHistory(direction) {
        if (!this.inputElement) return;

        if (direction === -1 && this.historyIndex === this.inputHistory.length && this.inputElement.value.trim() !== '') {
            if (this.inputHistory.length === 0 || this.inputHistory[this.inputHistory.length - 1] !== this.inputElement.value.trim()) {
                this.inputHistory.push(this.inputElement.value.trim());
                this.setLocalStorageItem(this.HISTORY_KEY, JSON.stringify(this.inputHistory));
            }
        }

        this.historyIndex += direction;

        if (this.historyIndex < 0) {
            this.historyIndex = 0;
        } else if (this.historyIndex > this.inputHistory.length) {
            this.historyIndex = this.inputHistory.length;
        }

        if (this.historyIndex === this.inputHistory.length) {
            this.inputElement.value = '';
        } else {
            this.inputElement.value = this.inputHistory[this.historyIndex];
            this.inputElement.setSelectionRange(this.inputElement.value.length, this.inputElement.value.length);
        }
    }

    /**
     * Configura el iframe para que sirva como contexto de ejecución de la consola.
     */
    async setupIframeContext() {
        return new Promise(resolve => {
            if (!this.consoleIframe) {
                originalError("Iframe de consola no encontrado.");
                return resolve();
            }

            this.consoleIframe.src = 'about:blank';

            this.consoleIframe.onload = () => {
                this.iframeWindow = this.consoleIframe.contentWindow;

                if (this.iframeWindow) {
                    this.iframeWindow.__appendConsoleMessage = (msg, type, ts) => {
                        this.appendMessage(msg, type, ts);
                    };

                    this.iframeWindow.eval(`
                        (function() {
                            var originalLog = console.log;
                            var originalWarn = console.warn;
                            var originalError = console.error;

                            function formatArgs(args) {
                                return Array.from(args).map(arg => {
                                    if (typeof arg === 'object' && arg !== null) {
                                        try { return JSON.stringify(arg, null, 2); } catch (e) { return String(arg); }
                                    }
                                    return String(arg);
                                }).join(' ');
                            }

                            console.log = function() {
                                var msg = formatArgs(arguments);
                                if (window.__appendConsoleMessage) { window.__appendConsoleMessage(msg, 'IFRAME_LOG', new Date().toLocaleTimeString()); }
                                originalLog.apply(this, arguments);
                            };
                            console.warn = function() {
                                var msg = formatArgs(arguments);
                                if (window.__appendConsoleMessage) { window.__appendConsoleMessage(msg, 'IFRAME_WARN', new Date().toLocaleTimeString()); }
                                originalWarn.apply(this, arguments);
                            };
                            console.error = function() {
                                var msg = formatArgs(arguments);
                                if (window.__appendConsoleMessage) { window.__appendConsoleMessage(msg, 'IFRAME_ERROR', new Date().toLocaleTimeString()); }
                                originalError.apply(this, arguments);
                            };
                        })();
                    `);
                }
                resolve();
            };
        });
    }

    /**
     * Obtiene un elemento de localStorage con manejo de errores.
     * @param {string} key - La clave del elemento.
     * @param {*} defaultValue - Valor por defecto si no se encuentra o hay error.
     * @returns {*} - El valor recuperado o el valor por defecto.
     */
    getLocalStorageItem(key, defaultValue) {
        try {
            const item = localStorage.getItem(key);
            return item !== null ? item : defaultValue;
        } catch (e) {
            console.error("Error al leer de localStorage:", e);
            return defaultValue;
        }
    }

    /**
     * Guarda un elemento en localStorage con manejo de errores.
     * @param {string} key - La clave del elemento.
     * @param {*} value - El valor a guardar.
     */
    setLocalStorageItem(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            console.error("Error al escribir en localStorage:", e);
        }
    }

    /**
     * Guarda el tamaño actual de la consola en localStorage.
     */
    saveConsoleSize() {
        if (this.consoleDisplay) {
            const actualWidth = `${this.consoleDisplay.offsetWidth}px`;
            const actualHeight = `${this.consoleDisplay.offsetHeight}px`;
            this.setLocalStorageItem(this.WIDTH_KEY, actualWidth);
            this.setLocalStorageItem(this.HEIGHT_KEY, actualHeight);
        }
    }

    /**
     * Función debounce para limitar la frecuencia de ejecución de una función.
     * @param {Function} func - La función a debounced.
     * @param {number} delay - El retardo en milisegundos.
     * @returns {Function} - La función debounced.
     */
    debounce(func, delay) {
        let timeout;
        return function(...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), delay);
        };
    }

    /**
     * Vacía el buffer de mensajes y los añade al textarea de la consola.
     */
    flushMessageBuffer() {
        while (consoleMessageBuffer.length > 0) {
            const entry = consoleMessageBuffer.shift();
            this.appendMessage(`${entry.message}`, entry.type, entry.timestamp);
        }
    }

    /**
     * Oculta la consola virtual y muestra el botón de 'Mostrar Consola'.
     */
    hideConsole() {
        this.isConsoleVisible = false;
        this.updateVisibility();
        this.setLocalStorageItem(this.VISIBLE_KEY, 'false');
        this.saveConsoleSize();
    }

    /**
     * Muestra la consola virtual y oculta el botón de 'Mostrar Consola'.
     */
    showConsole() {
        this.isConsoleVisible = true;
        this.updateVisibility();
        this.setLocalStorageItem(this.VISIBLE_KEY, 'true');
        if (this.textarea) {
            this.textarea.scrollTop = this.textarea.scrollHeight;
        }
        if (this.inputElement) {
            this.inputElement.focus();
        }
    }

    /**
     * Actualiza la visibilidad de los elementos del componente.
     */
    updateVisibility() {
        if (this.consoleDisplay && this.showButton) {
            this.consoleDisplay.style.display = this.isConsoleVisible ? 'flex' : 'none';
            this.showButton.style.display = this.isConsoleVisible ? 'none' : 'block';
            if (!this.isConsoleVisible) {
                this.consoleDisplay.style.resize = 'none';
            } else {
                this.consoleDisplay.style.resize = 'both';
            }
        }
    }

    /**
     * Procesa la entrada del usuario desde el campo de input.
     * @param {string} input - La cadena de texto ingresada por el usuario.
     */
    processInput(input) {
        if (!input.trim()) return;

        if (this.inputHistory.length === 0 || this.inputHistory[this.inputHistory.length - 1] !== input.trim()) {
            this.inputHistory.push(input.trim());
            this.setLocalStorageItem(this.HISTORY_KEY, JSON.stringify(this.inputHistory));
        }

        this.appendMessage(`> ${input}`, 'INPUT');

        if (!this.iframeWindow) {
            this.appendMessage(`  Error: El contexto de la consola no está listo.`, 'ERROR');
            return;
        }

        let resultToDisplay = undefined;
        const finalCodeToExecute = this.cumulativeExecutedCode + '\n' + input;

        try {
            resultToDisplay = this.iframeWindow.eval(finalCodeToExecute);
            this.cumulativeExecutedCode = finalCodeToExecute;
        } catch (e) {
            this.appendMessage(`  Error: ${e.message}`, 'ERROR');
        }

        if (resultToDisplay !== undefined) {
            this.appendMessage(`  < ${JSON.stringify(resultToDisplay, null, 2)}`, 'OUTPUT');
        } else {
            if (input.trim().match(/^(let|const|var|function|class)\s/)) {
                this.appendMessage(`  < (Declaración ejecutada)`, 'OUTPUT');
            } else {
                this.appendMessage(`  < (undefined)`, 'OUTPUT');
            }
        }
    }

    /**
     * Añade un mensaje al área de texto de la consola.
     * @param {string} message - El mensaje a añadir.
     * @param {string} type - Tipo de mensaje (LOG, WARN, ERROR, INPUT, etc.).
     * @param {string} [timestamp] - Timestamp opcional si ya se generó antes.
     */
    appendMessage(message, type = 'LOG', timestamp = new Date().toLocaleTimeString()) {
        if (this.textarea) {
            this.textarea.value += `[${timestamp}] [${type}] ${message}\n`;
            if (this.isConsoleVisible) {
                this.textarea.scrollTop = this.textarea.scrollHeight;
            }
        }
    }

    /**
     * Limpia el contenido del área de texto de la consola y reinicia el contexto del iframe.
     */
    async clearConsole() {
        if (this.textarea) {
            this.textarea.value = '';
        }
        this.cumulativeExecutedCode = '';
        await this.setupIframeContext();
        this.appendMessage('Consola y contexto de ejecución limpiados.', 'SYSTEM');
    }
}

// Define el nuevo elemento personalizado 'virtual-console'
window.customElements.define('virtual-console', VirtualConsoleComponent);
