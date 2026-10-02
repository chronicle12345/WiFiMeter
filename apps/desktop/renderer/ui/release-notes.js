import { marked } from '../../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../../node_modules/dompurify/dist/purify.es.mjs';

// Release content is remote input: render Markdown, then retain only document markup.
export function releaseNotes(markdown) {
    const html = marked.parse(String(markdown || ''), { gfm: true, breaks: false, async: false });
    if (!DOMPurify.sanitize) return '';
    return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p','br','h1','h2','h3','h4','h5','h6','ul','ol','li','strong','em','del','blockquote','pre','code','hr','table','thead','tbody','tr','th','td','a'],
        ALLOWED_ATTR: ['href','title'], ALLOW_DATA_ATTR: false,
        ALLOWED_URI_REGEXP: /^https:\/\//i
    });
}
