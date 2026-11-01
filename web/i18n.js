// The interface in the phone's language: Chinese as written, English otherwise (?lang=en / ?lang=zh to try the other).
// The page's words are written in Chinese inside t`…`; in English each run of Chinese words between markup and values
// is looked up in EN (punctuation and spaces around it kept), and a run not there yet stays as it is.
// What people and agents write (conversation titles, messages) is never translated.
import { EN } from './i18n-en.js';

const asked = new URLSearchParams(location.search).get('lang');
export const LANG = asked === 'en' || asked === 'zh' ? asked : /^zh/i.test(navigator.language) ? 'zh' : 'en';
document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';

const RUN = /[^<>"{}]*[一-鿿「」][^<>"{}]*/g;
const EDGE = /^([\s·:：,，—-]*)([\s\S]*?)([\s·:：,，—-]*)$/;

/** One stretch of words: its English, or itself. */
function phrase(run) {
  const [, lead, core, tail] = EDGE.exec(run);
  const en = EN[core];
  return en === undefined ? run : lead + en + tail;
}

/** Text of the page, possibly with markup in it. */
export function tr(text) {
  if (LANG === 'zh' || !text) return text;
  // Chinese punctuation left between words and values reads as English punctuation.
  return text.replace(RUN, phrase).replace(/[：、，（）「」]/g, (c) => ({ '：': ': ', '、': ', ', '，': ', ', '（': ' (', '）': ')', '「': '"', '」': '"' })[c]);
}

/** t`…${x}…`: the words around the values in the phone's language. */
export function t(strings, ...values) {
  let out = tr(strings[0]);
  for (let i = 0; i < values.length; i++) out += values[i] + tr(strings[i + 1]);
  return out;
}

/** The words written in index.html, once, when the page starts. */
export function translatePage(root = document.body) {
  if (LANG === 'zh') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/[一-鿿]/.test(n.nodeValue)) n.nodeValue = tr(n.nodeValue);
  for (const el of root.querySelectorAll('[placeholder],[aria-label],[title]')) {
    for (const a of ['placeholder', 'aria-label', 'title']) if (el.hasAttribute(a)) el.setAttribute(a, tr(el.getAttribute(a)));
  }
  document.title = tr(document.title);
}
