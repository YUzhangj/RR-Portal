const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'node_modules/exceljs/lib/xlsx/xform/sheet/cell-xform.js');
if (!fs.existsSync(file)) process.exit(0);
let content = fs.readFileSync(file, 'utf8');
const needle = `throw new Error(
              \`Shared Formula master must exist above and or left of clone for cell \${model.address}\`
            );`;
if (content.includes(needle)) {
  content = content.replace(needle, `// patched: skip missing master, keep cell as-is
            break;`);
  fs.writeFileSync(file, content);
  console.log('patched exceljs shared formula fix');
}
