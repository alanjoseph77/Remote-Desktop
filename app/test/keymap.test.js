// Every mapped key must exist in the nut-js Key enum.
const assert = require('assert');
const { Key } = require('@nut-tree-fork/nut-js');
const map = require('../src/keymap');
const missing = Object.entries(map).filter(([, n]) => Key[n] === undefined);
assert.deepStrictEqual(missing, [], 'Unknown nut-js keys: ' + JSON.stringify(missing));
for (const c of ['KeyA', 'Digit5', 'F12', 'Enter', 'ControlLeft', 'MetaLeft', 'ArrowUp', 'Numpad7', 'Space'])
  assert.ok(map[c], 'missing ' + c);
console.log(`keymap ok (${Object.keys(map).length} keys)`);
