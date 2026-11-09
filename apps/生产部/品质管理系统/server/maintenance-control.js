'use strict';
const fs = require('node:fs');
const path = require('node:path');
const directory = process.env.DATA_PATH || path.join(__dirname, 'data');
const flag = path.join(directory, 'maintenance.lock');
const action = process.argv[2];
if (!['on', 'off', 'status'].includes(action)) throw new Error('用法：node server/maintenance-control.js on|off|status');
if (action === 'on') { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(flag, 'maintenance\n'); }
if (action === 'off') { try { fs.unlinkSync(flag); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
const enabled = /^(1|true)$/i.test(process.env.QC_MAINTENANCE || '') || fs.existsSync(flag);
console.log(enabled ? '系统修复中：操作已暂停' : '维护模式已关闭：页面核对后刷新继续');
