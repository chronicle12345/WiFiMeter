
// 网络与应用共享遮罩、标题和内容结构，焦点与关闭行为由调用方管理。
export function drawerShell({ title, closeLabel, subtitle = '', tabs = '', back = '', badge = '', content, icon }) {
    return `<div class="backdrop" data-action="close-drawer"></div><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle"><header class="drawer-head">${back}<div class="between"><div class="flex gap8"><h2 id="drawerTitle">${title}</h2>${badge}</div><button class="icon-btn" data-action="close-drawer" id="closeDrawer" aria-label="${closeLabel}">${icon('close')}</button></div>${subtitle}</header>${tabs}<div class="drawer-content" ${tabs?'role="tabpanel"':''}>${content}</div></section>`;
}
