// The whole crypto suite again, with the native backend switched on (run on Node's crypto, whose API
// react-native-quick-crypto copies): `npx jest -c jest.native-crypto.config.js src/crypto`
const nodeCrypto = require('crypto');
const { nodeStyleBackend, selfTest } = require('./src/crypto/v2-platform/fastCrypto');
const { useFastCrypto } = require('./src/crypto/v2/primitives');
const passed = selfTest(nodeStyleBackend(nodeCrypto, (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength)));
if (Object.keys(passed).length !== 7) throw new Error('native backend failed its self-test');
useFastCrypto(passed);
