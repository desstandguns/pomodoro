// `node --test tests/` で実行されるファイル。
// このフォルダの *.test.js をすべて読み込んで、まとめて実行します。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

for (const name of fs.readdirSync(__dirname).sort()) {
  if (name.endsWith('.test.js')) require(path.join(__dirname, name));
}
