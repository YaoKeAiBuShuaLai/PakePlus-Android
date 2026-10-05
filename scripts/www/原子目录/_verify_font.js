/* _verify_font.js —— 需求五静态校验（无需浏览器 / 静态服务）
 * 校验「界面与主题 › 文字颜色」已并入「面板文字样式 › 面板文字色」：
 *   1) 界面与主题分区(g1)不再有名为「文字颜色」的 gsColor 控件；
 *   2) 面板文字样式分区(g2)仍恰好有一个名为「面板文字色」的 gsColor 控件；
 *   3) sunview.js 内不再直接读写 theme.darkInk / theme.lightInk
 *      （该状态改由 app.js 的 applyPanelFont / applyUiTheme 双向同步）。
 * 运行：node 原子目录/_verify_font.js
 */
const fs = require('fs');
const path = require('path');

// 定位 sunview.js（脚本放在 原子目录 内，上一级即项目根）
const root = path.resolve(__dirname, '..');
const file = path.join(root, 'sunview.js');
if (!fs.existsSync(file)) { console.error('找不到 sunview.js：', file); process.exit(2); }
const src = fs.readFileSync(file, 'utf8');

const checks = [];
function assert(name, cond) { checks.push({ name, ok: !!cond }); }

// 1) 界面与主题(g1) 不应再有「文字颜色」控件
const dupInTheme = /gsColor\(\s*g1\s*,\s*'文字颜色'/.test(src);
assert('界面与主题(g1) 已移除「文字颜色」控件', !dupInTheme);

// 2) 面板文字样式(g2) 仍恰好有一个「面板文字色」控件
const panelColorMatches = src.match(/gsColor\(\s*g2\s*,\s*'面板文字色'/g) || [];
assert('面板文字样式(g2) 恰好一个「面板文字色」控件（实际 ' + panelColorMatches.length + ' 个）', panelColorMatches.length === 1);

// 3) sunview.js 内不再出现 theme.darkInk / theme.lightInk（直接绑定）
const leftover = /theme\.(darkInk|lightInk)/.test(src);
assert('sunview.js 内不再直接读写 theme.darkInk/lightInk', !leftover);

// 报告
let allOk = true;
for (const c of checks) {
  console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.name);
  if (!c.ok) allOk = false;
}
console.log('\n结果：' + (allOk ? '全部通过 ✅' : '存在失败 ❌'));
process.exit(allOk ? 0 : 1);
