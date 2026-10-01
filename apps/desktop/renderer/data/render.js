// 比较原始渲染结果，避免无变化刷新破坏焦点、文字选择和表单状态。
const rendered = new WeakMap();
export function updateRegion(element, html, { selection, force = false } = {}) {
    if (!element || (!force && rendered.get(element) === html)) return false;
    if (selection && !selection.isCollapsed && element.contains(selection.anchorNode)) return false;
    element.innerHTML = html;
    rendered.set(element, html);
    return true;
}
