// See jest.native-crypto.setup.js
const base = require('./jest.config');
module.exports = { ...base, setupFilesAfterEnv: [...(base.setupFilesAfterEnv || []), '<rootDir>/jest.native-crypto.setup.js'] };
