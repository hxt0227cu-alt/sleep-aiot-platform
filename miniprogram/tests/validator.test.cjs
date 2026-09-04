const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../src/utils/validator.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const loaded = { exports: {} }
new Function('module', 'exports', 'require', compiled)(loaded, loaded.exports, require)
const { validators, validateForm } = loaded.exports

test('validators accept valid identifiers and reject malformed input', () => {
  assert.equal(validators.phone('13800138000'), true)
  assert.equal(validators.phone('1380013800'), false)
  assert.equal(validators.email('user@example.com'), true)
  assert.equal(validators.email('not-an-email'), false)
  assert.equal(validators.bindingCode('123456'), true)
  assert.equal(validators.bindingCode('12345a'), false)
})

test('validateForm reports rejected fields without dropping valid fields', () => {
  const result = validateForm(
    { phone: 'invalid', deviceId: 'ok_device-01' },
    { phone: validators.phone, deviceId: validators.deviceId },
  )
  assert.equal(result.valid, false)
  assert.equal(typeof result.errors.phone, 'string')
  assert.equal(result.errors.deviceId, undefined)
})
