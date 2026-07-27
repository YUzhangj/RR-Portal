'use strict';

const fs = require('fs');
const path = require('path');

// Excel templates are stored as sub-50KB binary chunks so the repository's
// branch-asset contract can inspect them without rejecting one oversized blob.
function readTemplateParts(templateName) {
  const directory = path.join(__dirname, '../templates');
  const prefix = `${templateName}.part-`;
  const chunks = fs.readdirSync(directory)
    .filter(filename => filename.startsWith(prefix))
    .sort()
    .map(filename => fs.readFileSync(path.join(directory, filename)));
  if (!chunks.length) throw new Error(`模板分片不存在：${templateName}`);
  return Buffer.concat(chunks);
}

module.exports = { readTemplateParts };
