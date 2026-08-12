# Long Translate browser bridge (development)

This directory contains the Manifest V3 development extension. It keeps website access user-scoped through `activeTab`: the content script is injected only after the user selects **在当前页面启用划词翻译**, and a page refresh removes it. It reads only the current selection and sends it to the desktop app only after the user selects the **译** action.

The manifest, popup, selection overlay, accessibility labels and user-facing failure states follow the browser UI language through Chromium i18n. English is the default locale and Simplified Chinese is bundled; neither locale changes the permission or data boundary.

The committed manifest public key fixes the unpacked development extension ID at:

`imaogjlfhfohdnngppnfhapdfkaldmkn`

The key is public identity material, not a signing private key. Store builds must replace the development origin with the real Chrome Web Store and Edge Add-ons IDs.

## Local smoke check

1. Run `npm run build:extension`.
2. Build the desktop executable, then register it for the development extension origin:
   `long-translate.exe --register-native-host --origin chrome-extension://imaogjlfhfohdnngppnfhapdfkaldmkn/`
3. Load `browser-extension/dist` as an unpacked extension in `chrome://extensions` or `edge://extensions`.
4. Open the extension popup, select **检查桌面连接**, then choose **在当前页面启用划词翻译** on a normal HTTP(S) page.
5. Select page text and choose **译**; verify the translated result, copy action, cancellation and close action.
6. After a successful translation, choose **收藏到生词本** and verify the entry in the desktop app. An existing translation-only pairing must be renewed before this write is allowed.
7. Before replacing or deleting that executable, run `long-translate.exe --unregister-native-host`.

The popup should report the desktop version and pairing state. Translation requires an approved `translation` capability; saving requires the separate `wordbook` capability. The overlay sends only the selected word and returned translation by default, not surrounding page content. Browser-internal pages and extension stores must reject script injection; the extension does not request persistent host permissions or declare always-on content scripts.
