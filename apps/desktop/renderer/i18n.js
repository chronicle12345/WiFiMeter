import { english } from './ui/english.js';
let language = 'zh-CN';
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(Object.keys(english).sort((a,b)=>b.length-a.length).map(escapeRegex).join('|'), 'g');
export function setLanguage(value) { language = value === 'en' ? 'en' : 'zh-CN'; }
export function getLanguage() { return language; }
export function getLocale() { return language === 'en' ? 'en-US' : 'zh-CN'; }
export function t(text) {
    if (language !== 'en') return text;
    return text.replace(pattern, key => english[key]).replace(/。/g,'.').replace(/，/g,', ').replace(/：/g,': ').replace(/；/g,'; ').replace(/（/g,'(').replace(/）/g,')');
}
// 模板的插入值可能是 SSID、路径或用户备注，只翻译静态片段。
export function tr(strings, ...values) { return strings.map((text,index)=>t(text)+(index<values.length?values[index]:'')).join(''); }
