; Included by electron-builder's NSIS script (build.nsis.include).
;
; electron-builder registers no URL protocols on Windows, so a codecast://
; link (a browser's "Install as app" hand-off) would reach nothing until the
; app's first launch claimed it. Register it per user at install, the same
; key app.setAsDefaultProtocolClient writes, and drop it on uninstall (an
; update's uninstall of the old version keeps it).

!macro customInstall
  WriteRegStr HKCU "Software\Classes\codecast" "" "URL:Codecast"
  WriteRegStr HKCU "Software\Classes\codecast" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\codecast\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\codecast\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\codecast"
  ${endIf}
!macroend
