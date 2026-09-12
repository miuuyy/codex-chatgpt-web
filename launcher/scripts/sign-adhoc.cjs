const { signAsync } = require("@electron/osx-sign");

// electron-builder may treat '-' as a certificate-name substring before invoking this hook.
// Enforce the actual codesign identity at the signing boundary and bypass identity lookup.
module.exports = async function signAdHoc(options) {
  return signAsync({ ...options, identity: "-", identityValidation: false });
};
