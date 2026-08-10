# Long Translate browser bridge (development)

This directory contains the first Manifest V3 development shell. It intentionally has only the `nativeMessaging` permission and verifies one persistent `hello` -> `ping` Native Messaging session. It does not inject a content script, request website access, read page content, or translate text.

The committed manifest public key fixes the unpacked development extension ID at:

`imaogjlfhfohdnngppnfhapdfkaldmkn`

The key is public identity material, not a signing private key. Store builds must replace the development origin with the real Chrome Web Store and Edge Add-ons IDs.

## Local smoke check

1. Run `npm run build:extension`.
2. Build the desktop executable, then register it for the development extension origin:
   `long-translate.exe --register-native-host --origin chrome-extension://imaogjlfhfohdnngppnfhapdfkaldmkn/`
3. Load `browser-extension/dist` as an unpacked extension in `chrome://extensions` or `edge://extensions`.
4. Open the extension popup and select **检查连接**.
5. Before replacing or deleting that executable, run `long-translate.exe --unregister-native-host`.

The popup should report the desktop version, `required` pairing state, and the `hello`/`ping` round-trip time. A successful check is not yet a translation-capable browser extension.
