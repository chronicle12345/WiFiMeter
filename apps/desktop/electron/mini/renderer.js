import { liveRates } from './rates.js';
const upload = document.getElementById('upload');
const download = document.getElementById('download');
function renderRate(element, text) {
    const [value, ...unit] = text.split(' ');
    element.querySelector('.rate-number').textContent = value;
    element.querySelector('.rate-unit').textContent = unit.length ? ' ' + unit.join(' ') : '';
}
const subscriptions = [
    window.miniDesktop.onLive(event => {
        const rates = liveRates(event);
        renderRate(upload, rates.upload);
        renderRate(download, rates.download);
    }),
    window.miniDesktop.onPreferences(preferences => {
        document.body.dataset.shape = preferences.miniShape;
        document.body.dataset.palette = preferences.miniPalette;
        document.documentElement.dataset.palette = preferences.miniPalette;
    }),
    window.miniDesktop.onState(state => {
        document.body.dataset.collapsed = String(state.collapsed);
        document.body.dataset.edge = state.edge || '';
        document.querySelector('main').inert = state.collapsed;
    })
];
document.getElementById('open').addEventListener('click', () => window.miniDesktop.openMain().catch(console.error));
document.getElementById('close').addEventListener('click', () => window.miniDesktop.close().catch(console.error));
window.addEventListener('unload', () => subscriptions.forEach(unsubscribe => unsubscribe()), { once: true });
