module.exports = {
  root: true,
  extends: ['taro/react'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  ignorePatterns: ['dist/', 'node_modules/'],
  rules: { 'react/react-in-jsx-scope': 'off' },
}
