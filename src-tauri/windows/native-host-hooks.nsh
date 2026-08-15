!define LONG_TRANSLATE_DEV_EXTENSION_ORIGIN "chrome-extension://imaogjlfhfohdnngppnfhapdfkaldmkn/"

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering Long Translate browser bridge"
  ClearErrors
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --register-native-host --origin ${LONG_TRANSLATE_DEV_EXTENSION_ORIGIN}' $0
  ${If} ${Errors}
    Abort "Unable to start Long Translate Native Host registration"
  ${ElseIf} $0 <> 0
    Abort "Long Translate Native Host registration failed with exit code $0"
  ${EndIf}
  Delete "$INSTDIR\com.long.translate.json"
  Delete "$INSTDIR\com.long.translate.json.long-translate-backup"
  Delete "$INSTDIR\.com.long.translate.json.*.tmp"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DetailPrint "Removing Long Translate browser bridge registration"
    !if "${ARCH}" == "x64"
      SetRegView 64
    !else if "${ARCH}" == "arm64"
      SetRegView 64
    !endif
    ReadRegStr $0 HKCU "SOFTWARE\Google\Chrome\NativeMessagingHosts\com.long.translate" ""
    ${If} $0 == "$LOCALAPPDATA\com.long.translate\native-messaging\com.long.translate.json"
      DeleteRegKey HKCU "SOFTWARE\Google\Chrome\NativeMessagingHosts\com.long.translate"
    ${EndIf}
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.long.translate" ""
    ${If} $0 == "$LOCALAPPDATA\com.long.translate\native-messaging\com.long.translate.json"
      DeleteRegKey HKCU "SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.long.translate"
    ${EndIf}
    Delete "$LOCALAPPDATA\com.long.translate\native-messaging\com.long.translate.json"
    Delete "$LOCALAPPDATA\com.long.translate\native-messaging\com.long.translate.json.long-translate-backup"
    Delete "$LOCALAPPDATA\com.long.translate\native-messaging\.com.long.translate.json.*.tmp"
    RMDir "$LOCALAPPDATA\com.long.translate\native-messaging"
    Delete "$INSTDIR\com.long.translate.json"
    Delete "$INSTDIR\com.long.translate.json.long-translate-backup"
    Delete "$INSTDIR\.com.long.translate.json.*.tmp"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
