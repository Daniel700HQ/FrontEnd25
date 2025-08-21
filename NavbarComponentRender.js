// NavbarComponentRender.js

class NavbarComponent extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    // Usamos async/await para manejar la carga asíncrona del archivo HTML
    async connectedCallback() {
        const response = await fetch('NavbarComponent.html');
        const html = await response.text();
        this.shadowRoot.innerHTML = html;
    }
}


window.customElements.define('dark-navbar', NavbarComponent);
